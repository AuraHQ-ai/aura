import { pruneMessages } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { supportsEffort, isAnthropicModel, buildContextManagement } from "../lib/ai.js";
import { logger } from "../lib/logger.js";

export const STEP_LIMIT = 250;
export const HEADLESS_STEP_LIMIT = 350;
const WARNING_THRESHOLD = 200;
const HEADLESS_WARNING_THRESHOLD = 300;

const WRAP_UP_MESSAGE =
  "IMPORTANT: You're approaching your step limit ({stepCount}/{limit}). " +
  "Start wrapping up — summarize your findings and post results now. " +
  "Do not start new investigations or long tool chains.";

// ── Loop Detection ───────────────────────────────────────────────────────────

const LOOP_WINDOW = 8;
const LOOP_WARN_THRESHOLD = 3;
const LOOP_STOP_THRESHOLD = 5;

const LOOP_WARNING =
  "WARNING: You appear to be in a loop — you've made the same tool call " +
  "with the same arguments {count} times in the last {window} steps. " +
  "STOP repeating this call. Re-read the user's most recent message, " +
  "reconsider your approach, and either try a different strategy or " +
  "summarize what you've found so far and respond to the user.";

const LOOP_FORCE_STOP =
  "CRITICAL: You are stuck in an infinite loop — the same tool call has " +
  "repeated {count} times. You MUST stop calling tools immediately. " +
  "Summarize whatever you have and respond to the user NOW. " +
  "Do NOT make any more tool calls.";

interface ToolCallSignature {
  name: string;
  argsHash: string;
  normalizedArgsHash: string;
}

function hashArgs(args: unknown): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/**
 * Normalize a shell command for semantic comparison.
 * Strips comments, collapses whitespace, removes insignificant formatting
 * differences so functionally-identical commands produce the same hash.
 */
function normalizeCommand(cmd: string): string {
  return cmd
    .split("\n")
    .map((line) => line.replace(/(?<!['"\\])#[^!].*$/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compute a normalized hash for tool args. For `run_command`, normalizes
 * the command string so that comments/whitespace differences don't prevent
 * semantic loop detection.
 */
function normalizedHashArgs(toolName: string, args: unknown): string {
  if (toolName === "run_command" && args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.command === "string") {
      const normalized = { ...a, command: normalizeCommand(a.command) };
      try {
        return JSON.stringify(normalized);
      } catch {
        return String(normalized);
      }
    }
  }
  return hashArgs(args);
}

function detectLoop(history: ToolCallSignature[]): {
  looping: boolean;
  count: number;
  toolName?: string;
  semantic?: boolean;
} {
  if (history.length < LOOP_WARN_THRESHOLD) return { looping: false, count: 0 };

  const last = history[history.length - 1];

  // Exact match (original behavior)
  let exactCount = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].name === last.name && history[i].argsHash === last.argsHash) {
      exactCount++;
    } else {
      break;
    }
  }
  if (exactCount >= LOOP_WARN_THRESHOLD) {
    return { looping: true, count: exactCount, toolName: last.name };
  }

  // Semantic match (normalized args — catches comment/whitespace variations)
  let normalizedCount = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (
      history[i].name === last.name &&
      history[i].normalizedArgsHash === last.normalizedArgsHash
    ) {
      normalizedCount++;
    } else {
      break;
    }
  }
  if (normalizedCount >= LOOP_WARN_THRESHOLD) {
    return { looping: true, count: normalizedCount, toolName: last.name, semantic: true };
  }

  return { looping: false, count: Math.max(exactCount, normalizedCount) };
}

// ── Circuit Breaker (consecutive tool-type failures) ─────────────────────────

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_STOP_THRESHOLD = 5;

const CIRCUIT_BREAKER_WARNING =
  "WARNING: Circuit breaker — {count} consecutive {toolName} calls have " +
  "failed. Even though the commands differ slightly, they are all failing. " +
  "STOP retrying variations of the same approach. Analyze WHY it's failing, " +
  "try a fundamentally different strategy, or tell the user what's going wrong.";

const CIRCUIT_BREAKER_STOP =
  "CRITICAL: Circuit breaker — {count} consecutive {toolName} failures. " +
  "You MUST stop calling this tool immediately. Summarize the failure " +
  "pattern and respond to the user NOW. Do NOT retry.";

interface ToolCallOutcome {
  name: string;
  failed: boolean;
}

/**
 * Determine if a tool call result represents a failure.
 * For `run_command`, non-zero exit codes and timeouts count as failures.
 * For other tools, `ok === false` or the presence of `error` signals failure.
 */
function isToolCallFailure(toolName: string, output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  if (o.ok === false) return true;
  if (toolName === "run_command" && "exit_code" in o && o.exit_code !== 0) return true;
  return false;
}

function detectCircuitBreaker(outcomes: ToolCallOutcome[]): {
  triggered: boolean;
  count: number;
  toolName?: string;
} {
  if (outcomes.length < CIRCUIT_BREAKER_THRESHOLD) return { triggered: false, count: 0 };

  const last = outcomes[outcomes.length - 1];
  if (!last.failed) return { triggered: false, count: 0 };

  let count = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (outcomes[i].name === last.name && outcomes[i].failed) {
      count++;
    } else {
      break;
    }
  }

  if (count >= CIRCUIT_BREAKER_THRESHOLD) {
    return { triggered: true, count, toolName: last.name };
  }

  return { triggered: false, count: 0 };
}

export type EffortLevel = "low" | "medium" | "high";

type PrepareStepResult = {
  system?: string;
  providerOptions?: ProviderOptions;
  model?: LanguageModel;
  messages?: Array<ModelMessage>;
} | undefined;

type PrepareStepFn = (options: {
  stepNumber: number;
  steps: Array<any>;
  messages: Array<ModelMessage>;
  [key: string]: unknown;
}) => PrepareStepResult | PromiseLike<PrepareStepResult>;

/**
 * Build a `prepareStep` callback for AI SDK's streamText/generateText.
 *
 * Handles two concerns:
 * 1. Effort escalation (Anthropic only): starts at defaultEffort (usually "medium"),
 *    bumps to "high" when the agent is deep into a task or hitting tool failures,
 *    and optionally escalates the model from Sonnet to Opus for persistent failures.
 * 2. Step limit warning: injects a system-level wrap-up nudge near the step limit.
 */
export function createPrepareStep(opts: {
  stepLimit?: number;
  warningThreshold?: number;
  systemPrompt: string;
  dynamicContext?: string;
  defaultEffort?: EffortLevel;
  modelId?: string;
  getEscalationModel?: () => Promise<{ modelId: string; model: LanguageModel }>;
}): PrepareStepFn {
  const limit = opts.stepLimit ?? STEP_LIMIT;
  const threshold = opts.warningThreshold ?? WARNING_THRESHOLD;
  const hasEffortSupport = opts.modelId ? supportsEffort(opts.modelId) : false;
  const modelIsAnthropic = opts.modelId ? isAnthropicModel(opts.modelId) : false;
  let currentEffort: EffortLevel = opts.defaultEffort ?? "medium";
  let hasEscalatedModel = false;
  let escalatedModel: { modelId: string; model: LanguageModel } | null = null;
  let failureCount = 0;
  const recentToolCalls: ToolCallSignature[] = [];
  const recentOutcomes: ToolCallOutcome[] = [];
  const OUTCOME_WINDOW = 12;

  return async ({ stepNumber, steps, messages }) => {
    let systemOverride: string | undefined;
    let providerOptions: ProviderOptions | undefined;
    let modelOverride: LanguageModel | undefined;

    // --- Tool failure detection (always active) ---
    const lastStep = Array.isArray(steps) && steps.length > 0
      ? steps[steps.length - 1]
      : null;

    const hadToolFailure = lastStep?.toolResults?.some(
      (r: any) => r.output?.ok === false || r.output?.error,
    ) ?? false;

    if (hadToolFailure) failureCount++;

    // --- Build failure map from tool results for circuit breaker ---
    const resultFailureMap = new Map<string, boolean>();
    if (lastStep?.toolResults && Array.isArray(lastStep.toolResults)) {
      for (const tr of lastStep.toolResults as any[]) {
        const trName = tr.toolName ?? "unknown";
        const trOutput = tr.output ?? tr.result;
        resultFailureMap.set(tr.toolCallId, isToolCallFailure(trName, trOutput));
      }
    }

    // --- Loop detection: track recent tool calls and detect repetition ---
    if (lastStep?.toolCalls && Array.isArray(lastStep.toolCalls)) {
      for (const tc of lastStep.toolCalls) {
        const name = tc.toolName ?? tc.name ?? "unknown";
        const args = tc.input ?? tc.args;
        recentToolCalls.push({
          name,
          argsHash: hashArgs(args),
          normalizedArgsHash: normalizedHashArgs(name, args),
        });
        recentOutcomes.push({
          name,
          failed: resultFailureMap.get(tc.toolCallId) ?? false,
        });
      }
      while (recentToolCalls.length > LOOP_WINDOW) {
        recentToolCalls.shift();
      }
      while (recentOutcomes.length > OUTCOME_WINDOW) {
        recentOutcomes.shift();
      }
    }

    // --- Exact / semantic loop detection ---
    const loopResult = detectLoop(recentToolCalls);
    let loopNudge: string | undefined;
    if (loopResult.looping) {
      if (loopResult.count >= LOOP_STOP_THRESHOLD) {
        loopNudge = LOOP_FORCE_STOP
          .replace("{count}", String(loopResult.count));
        logger.warn("prepareStep: loop detected — force stop", {
          stepNumber,
          toolName: loopResult.toolName,
          repeatCount: loopResult.count,
          semantic: loopResult.semantic ?? false,
        });
      } else {
        loopNudge = LOOP_WARNING
          .replace("{count}", String(loopResult.count))
          .replace("{window}", String(LOOP_WINDOW));
        logger.warn("prepareStep: loop detected — warning injected", {
          stepNumber,
          toolName: loopResult.toolName,
          repeatCount: loopResult.count,
          semantic: loopResult.semantic ?? false,
        });
      }
    }

    // --- Circuit breaker: consecutive failures of the same tool type ---
    const cbResult = detectCircuitBreaker(recentOutcomes);
    let circuitBreakerNudge: string | undefined;
    if (cbResult.triggered && !loopNudge) {
      if (cbResult.count >= CIRCUIT_BREAKER_STOP_THRESHOLD) {
        circuitBreakerNudge = CIRCUIT_BREAKER_STOP
          .replace("{count}", String(cbResult.count))
          .replace("{toolName}", cbResult.toolName ?? "tool");
        logger.warn("prepareStep: circuit breaker — force stop", {
          stepNumber,
          toolName: cbResult.toolName,
          consecutiveFailures: cbResult.count,
        });
      } else {
        circuitBreakerNudge = CIRCUIT_BREAKER_WARNING
          .replace("{count}", String(cbResult.count))
          .replace("{toolName}", cbResult.toolName ?? "tool");
        logger.warn("prepareStep: circuit breaker — warning injected", {
          stepNumber,
          toolName: cbResult.toolName,
          consecutiveFailures: cbResult.count,
        });
      }
    }

    // --- Effort escalation (only for models supporting Anthropic `effort` param) ---
    if (hasEffortSupport) {
      let newEffort = currentEffort;

      if (stepNumber > 8 || hadToolFailure) {
        if (currentEffort === "low") newEffort = "medium";
        else if (currentEffort === "medium") newEffort = "high";
      }

      if (newEffort !== currentEffort) {
        currentEffort = newEffort;
        logger.info("prepareStep: escalating effort", {
          stepNumber,
          effort: currentEffort,
        });
      }

      providerOptions = {
        anthropic: {
          effort: currentEffort,
          contextManagement: buildContextManagement(),
        },
      };
    } else if (modelIsAnthropic) {
      providerOptions = {
        anthropic: {
          contextManagement: buildContextManagement(),
        },
      };
    }

    // --- Model escalation: persistent failures → escalation model ---
    // For effort-supporting models: escalate after reaching max effort and still failing.
    // For other models: escalate after 3+ cumulative tool failures.
    const readyToEscalateModel = hasEffortSupport
      ? (currentEffort === "high" && hadToolFailure)
      : (failureCount >= 3);

    if (
      stepNumber > 15 &&
      readyToEscalateModel &&
      !hasEscalatedModel &&
      opts.getEscalationModel
    ) {
      try {
        escalatedModel = await opts.getEscalationModel();
        hasEscalatedModel = true;
        modelOverride = escalatedModel.model;
        logger.warn("prepareStep: escalating to escalation model", { stepNumber, modelId: escalatedModel.modelId });
      } catch (err: any) {
        logger.error("prepareStep: failed to load escalation model", {
          stepNumber,
          error: err?.message,
        });
      }
    }

    if (hasEscalatedModel && escalatedModel && !modelOverride) {
      modelOverride = escalatedModel.model;
    }

    // --- Step limit warning, loop detection, and circuit breaker nudges ---
    const nudges: string[] = [];

    if (loopNudge) {
      nudges.push(loopNudge);
    }

    if (circuitBreakerNudge) {
      nudges.push(circuitBreakerNudge);
    }

    if (stepNumber >= threshold) {
      const wrapUp = WRAP_UP_MESSAGE
        .replace("{stepCount}", String(stepNumber))
        .replace("{limit}", String(limit));
      nudges.push(wrapUp);
      logger.info("prepareStep: injecting wrap-up nudge", {
        stepNumber,
        limit,
      });
    }

    if (nudges.length > 0) {
      systemOverride = opts.systemPrompt
        + "\n\n"
        + (opts.dynamicContext ? opts.dynamicContext + "\n\n" : "")
        + nudges.join("\n\n");
    }

    const prunedMessages = pruneMessages({
      messages,
      toolCalls: "before-last-5-messages",
      reasoning: "before-last-message",
    });

    return {
      messages: prunedMessages,
      ...(systemOverride && { system: systemOverride }),
      ...(providerOptions && { providerOptions }),
      ...(modelOverride && { model: modelOverride }),
    };
  };
}

/** Factory for interactive Slack agent prepareStep (250-step limit). */
export function createInteractivePrepareStep(opts: {
  systemPrompt: string;
  dynamicContext?: string;
  modelId?: string;
  defaultEffort?: EffortLevel;
  getEscalationModel?: () => Promise<{ modelId: string; model: LanguageModel }>;
}): PrepareStepFn {
  return createPrepareStep({
    stepLimit: STEP_LIMIT,
    warningThreshold: WARNING_THRESHOLD,
    systemPrompt: opts.systemPrompt,
    dynamicContext: opts.dynamicContext,
    modelId: opts.modelId,
    defaultEffort: opts.defaultEffort,
    getEscalationModel: opts.getEscalationModel,
  });
}

/** Factory for headless job execution prepareStep (350-step limit). */
export function createHeadlessPrepareStep(opts: {
  systemPrompt: string;
  dynamicContext?: string;
  modelId?: string;
  defaultEffort?: EffortLevel;
  getEscalationModel?: () => Promise<{ modelId: string; model: LanguageModel }>;
}): PrepareStepFn {
  return createPrepareStep({
    stepLimit: HEADLESS_STEP_LIMIT,
    warningThreshold: HEADLESS_WARNING_THRESHOLD,
    systemPrompt: opts.systemPrompt,
    dynamicContext: opts.dynamicContext,
    modelId: opts.modelId,
    defaultEffort: opts.defaultEffort,
    getEscalationModel: opts.getEscalationModel,
  });
}

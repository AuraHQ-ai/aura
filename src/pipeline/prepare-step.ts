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
}

function hashArgs(args: unknown): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function detectLoop(history: ToolCallSignature[]): {
  looping: boolean;
  count: number;
  toolName?: string;
} {
  if (history.length < LOOP_WARN_THRESHOLD) return { looping: false, count: 0 };

  const last = history[history.length - 1];
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].name === last.name && history[i].argsHash === last.argsHash) {
      count++;
    } else {
      break;
    }
  }

  if (count >= LOOP_WARN_THRESHOLD) {
    return { looping: true, count, toolName: last.name };
  }

  return { looping: false, count };
}

// ── Semantic Command Circuit Breaker ─────────────────────────────────────────
// Catches cases where the LLM retries the same failing command with minor
// variations (different comments, whitespace, formatting) that evade the
// exact-match loop detector above.

const CMD_FAILURE_THRESHOLD = 3;
const CMD_FAILURE_WINDOW = 20;

const CMD_CIRCUIT_BREAKER =
  "CRITICAL: You have attempted the same failing command {count} consecutive " +
  "times{domainInfo}. The external service or command is persistently failing — " +
  "STOP retrying with variations. Report the failure to the user and move on. " +
  "Do NOT attempt this command again with different comments, formatting, or " +
  "minor tweaks.";

interface CommandFailureRecord {
  pattern: string;
  domain: string | null;
}

/** Strip comments, join line continuations, collapse whitespace. */
function normalizeCommand(command: string): string {
  return command
    .replace(/\\[\s]*\n/g, " ")
    .replace(/#[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Extract the hostname from the first URL found in a command string. */
function extractDomain(command: string): string | null {
  const match = command.match(/https?:\/\/([^\/\s'"\\]+)/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Derive a stable pattern from a shell command for fuzzy comparison.
 * For curl/wget, extracts method + host + path.
 * For other commands, takes the base command tokens.
 */
function extractCommandPattern(command: string): string {
  const normalized = normalizeCommand(command);

  const curlMatch = normalized.match(
    /curl\s+(?:.*?(?:-x|--request)\s+(\w+)\s+)?.*?(https?:\/\/[^\s'"]+)/,
  );
  if (curlMatch) {
    const method = curlMatch[1] || "get";
    try {
      const url = new URL(curlMatch[2]);
      return `curl:${method}:${url.host}${url.pathname}`;
    } catch {
      return `curl:${curlMatch[2].slice(0, 80)}`;
    }
  }

  const wgetMatch = normalized.match(/wget\s+.*?(https?:\/\/[^\s'"]+)/);
  if (wgetMatch) {
    try {
      const url = new URL(wgetMatch[1]);
      return `wget:${url.host}${url.pathname}`;
    } catch {
      return `wget:${wgetMatch[1].slice(0, 80)}`;
    }
  }

  const parts = normalized.split(/\s+/);
  let idx = 0;
  while (idx < parts.length && /^[a-z_]\w*=/i.test(parts[idx])) idx++;
  return parts.slice(idx, idx + 2).join(" ") || normalized.slice(0, 50);
}

/** Count consecutive tail entries that share the same pattern or domain. */
function detectCommandLoop(failures: CommandFailureRecord[]): {
  looping: boolean;
  count: number;
  domain?: string;
} {
  if (failures.length < CMD_FAILURE_THRESHOLD) {
    return { looping: false, count: 0 };
  }

  const last = failures[failures.length - 1];
  let count = 0;
  for (let i = failures.length - 1; i >= 0; i--) {
    const f = failures[i];
    const samePattern = f.pattern === last.pattern;
    const sameDomain = !!(last.domain && f.domain && f.domain === last.domain);
    if (samePattern || sameDomain) {
      count++;
    } else {
      break;
    }
  }

  if (count >= CMD_FAILURE_THRESHOLD) {
    return { looping: true, count, domain: last.domain ?? undefined };
  }
  return { looping: false, count };
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
  const commandFailures: CommandFailureRecord[] = [];

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

    // --- Loop detection: track recent tool calls and detect repetition ---
    if (lastStep?.toolCalls && Array.isArray(lastStep.toolCalls)) {
      for (const tc of lastStep.toolCalls) {
        recentToolCalls.push({
          name: tc.toolName ?? tc.name ?? "unknown",
          argsHash: hashArgs(tc.input ?? tc.args),
        });
      }
      while (recentToolCalls.length > LOOP_WINDOW) {
        recentToolCalls.shift();
      }
    }

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
        });
      } else {
        loopNudge = LOOP_WARNING
          .replace("{count}", String(loopResult.count))
          .replace("{window}", String(LOOP_WINDOW));
        logger.warn("prepareStep: loop detected — warning injected", {
          stepNumber,
          toolName: loopResult.toolName,
          repeatCount: loopResult.count,
        });
      }
    }

    // --- Semantic command circuit breaker: detect repeated failing commands ---
    if (lastStep?.toolCalls && Array.isArray(lastStep.toolCalls)) {
      let anyRunCmdSuccess = false;
      const stepCmdFailures: CommandFailureRecord[] = [];

      for (const tc of lastStep.toolCalls) {
        const toolName = tc.toolName ?? tc.name ?? "unknown";
        if (toolName !== "run_command") continue;

        const args = tc.input ?? tc.args;
        const command =
          typeof args === "object" && args?.command ? String(args.command) : "";

        const matchingResult = Array.isArray(lastStep.toolResults)
          ? lastStep.toolResults.find(
              (r: any) => r.toolCallId === tc.toolCallId,
            )
          : undefined;

        const output = matchingResult?.output ?? matchingResult?.result;
        const isFailed =
          output?.ok === false ||
          (typeof output?.exit_code === "number" && output.exit_code !== 0);

        if (isFailed) {
          stepCmdFailures.push({
            pattern: extractCommandPattern(command),
            domain: extractDomain(command),
          });
        } else if (matchingResult) {
          anyRunCmdSuccess = true;
        }
      }

      if (anyRunCmdSuccess) {
        commandFailures.length = 0;
      }
      commandFailures.push(...stepCmdFailures);
      while (commandFailures.length > CMD_FAILURE_WINDOW) {
        commandFailures.shift();
      }
    }

    let cmdCircuitNudge: string | undefined;
    const cmdLoopResult = detectCommandLoop(commandFailures);
    if (cmdLoopResult.looping) {
      const domainInfo = cmdLoopResult.domain
        ? ` targeting ${cmdLoopResult.domain}`
        : "";
      cmdCircuitNudge = CMD_CIRCUIT_BREAKER
        .replace("{count}", String(cmdLoopResult.count))
        .replace("{domainInfo}", domainInfo);
      logger.warn("prepareStep: command circuit breaker triggered", {
        stepNumber,
        consecutiveFailures: cmdLoopResult.count,
        domain: cmdLoopResult.domain,
      });
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

    // --- Step limit warning and loop detection nudges ---
    const nudges: string[] = [];

    if (loopNudge) {
      nudges.push(loopNudge);
    }

    if (cmdCircuitNudge) {
      nudges.push(cmdCircuitNudge);
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

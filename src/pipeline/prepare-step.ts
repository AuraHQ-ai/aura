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

// ── Semantic Loop Detection (Circuit Breaker) ────────────────────────────────
// Catches "same purpose, same failure" patterns that exact-string matching misses.
// Tracks consecutive run_command failures and detects repetition via normalization
// and URL extraction (e.g. 30 curl calls to the same endpoint with different comments).

const SEMANTIC_LOOP_THRESHOLD = 3;
const RAW_FAILURE_THRESHOLD = 5;

const CIRCUIT_BREAKER_WARNING =
  "WARNING: Circuit breaker — {count} consecutive `run_command` calls " +
  "have failed ({reason}). The command or external service is not working. " +
  "STOP retrying the same approach. Either try a fundamentally different " +
  "strategy or report the failure to the user with what you've learned.";

const CIRCUIT_BREAKER_STOP =
  "CRITICAL: Circuit breaker triggered — {count} consecutive `run_command` " +
  "calls have failed{detail}. You MUST stop retrying. Report the failure " +
  "to the user, explain what went wrong, and suggest alternatives. " +
  "Do NOT attempt the same command or endpoint again.";

interface CommandFailureRecord {
  normalizedCommand: string;
  urls: string[];
  baseCommand: string;
}

/** Strip shell comments and collapse whitespace for semantic comparison. */
function normalizeCommand(cmd: string): string {
  return cmd
    .replace(/(^|\s)#[^\n]*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract HTTP(S) URLs from a command string, normalized to origin+pathname. */
function extractUrls(cmd: string): string[] {
  const matches = cmd.match(/https?:\/\/[^\s"'`)\]}>]+/g);
  if (!matches) return [];
  return [...new Set(matches.map((u) => {
    try {
      const url = new URL(u);
      return url.origin + url.pathname;
    } catch {
      return u;
    }
  }))];
}

/** Extract the base command name (first token after env var assignments). */
function extractBaseCommand(cmd: string): string {
  const stripped = cmd.replace(/^\s*(\w+=\S+\s+)*/g, "").trim();
  return stripped.split(/\s/)[0] || stripped;
}

function detectSemanticLoop(failures: CommandFailureRecord[]): {
  isLoop: boolean;
  severity: "warn" | "stop";
  reason?: string;
  count: number;
} {
  const count = failures.length;

  if (count >= RAW_FAILURE_THRESHOLD) {
    return { isLoop: true, severity: "stop", reason: "too many consecutive failures", count };
  }

  if (count < SEMANTIC_LOOP_THRESHOLD) {
    return { isLoop: false, severity: "warn", count };
  }

  const recent = failures.slice(-SEMANTIC_LOOP_THRESHOLD);

  if (recent.every((f) => f.normalizedCommand === recent[0].normalizedCommand)) {
    return {
      isLoop: true,
      severity: count >= SEMANTIC_LOOP_THRESHOLD + 1 ? "stop" : "warn",
      reason: "same normalized command repeated",
      count,
    };
  }

  if (recent.every((f) => f.urls.length > 0)) {
    const sharedUrl = recent[0].urls.find((u) =>
      recent.every((f) => f.urls.includes(u)),
    );
    if (sharedUrl) {
      return {
        isLoop: true,
        severity: count >= SEMANTIC_LOOP_THRESHOLD + 1 ? "stop" : "warn",
        reason: `same endpoint ${sharedUrl}`,
        count,
      };
    }
  }

  if (
    recent.every((f) => f.baseCommand === recent[0].baseCommand) &&
    recent[0].baseCommand
  ) {
    return {
      isLoop: true,
      severity: count >= SEMANTIC_LOOP_THRESHOLD + 1 ? "stop" : "warn",
      reason: `same base command (${recent[0].baseCommand}) failing repeatedly`,
      count,
    };
  }

  return { isLoop: false, severity: "warn", count };
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
  const consecutiveCmdFailures: CommandFailureRecord[] = [];

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

    // --- Semantic loop detection (circuit breaker for run_command) ---
    let circuitBreakerNudge: string | undefined;
    if (lastStep?.toolCalls && lastStep?.toolResults) {
      const toolCalls: any[] = Array.isArray(lastStep.toolCalls) ? lastStep.toolCalls : [];
      const toolResults: any[] = Array.isArray(lastStep.toolResults) ? lastStep.toolResults : [];

      let hasRunCommand = false;
      let allRunCommandsFailed = true;

      for (const tc of toolCalls) {
        const name = tc.toolName ?? tc.name ?? "unknown";
        if (name !== "run_command") continue;
        hasRunCommand = true;

        const result = toolResults.find((r: any) => r.toolCallId === tc.toolCallId);
        const output = result?.output;
        const exitCode = output?.exit_code;
        const isFailed =
          (output?.ok === false) ||
          (typeof exitCode === "number" && exitCode !== 0);

        if (isFailed) {
          const command = tc.input?.command ?? tc.args?.command ?? "";
          consecutiveCmdFailures.push({
            normalizedCommand: normalizeCommand(command),
            urls: extractUrls(command),
            baseCommand: extractBaseCommand(normalizeCommand(command)),
          });
        } else {
          allRunCommandsFailed = false;
        }
      }

      if (hasRunCommand && !allRunCommandsFailed) {
        consecutiveCmdFailures.length = 0;
      }

      if (!hasRunCommand && toolCalls.length > 0) {
        consecutiveCmdFailures.length = 0;
      }

      const semanticResult = detectSemanticLoop(consecutiveCmdFailures);
      if (semanticResult.isLoop) {
        const detail = semanticResult.reason
          ? ` (${semanticResult.reason})`
          : "";
        if (semanticResult.severity === "stop") {
          circuitBreakerNudge = CIRCUIT_BREAKER_STOP
            .replace("{count}", String(semanticResult.count))
            .replace("{detail}", detail);
        } else {
          circuitBreakerNudge = CIRCUIT_BREAKER_WARNING
            .replace("{count}", String(semanticResult.count))
            .replace("{reason}", semanticResult.reason ?? "repeated failures");
        }
        logger.warn("prepareStep: semantic loop detected — circuit breaker", {
          stepNumber,
          severity: semanticResult.severity,
          reason: semanticResult.reason,
          consecutiveFailures: semanticResult.count,
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

    // --- Step limit warning and loop detection nudges ---
    const nudges: string[] = [];

    if (circuitBreakerNudge) {
      nudges.push(circuitBreakerNudge);
    }

    if (loopNudge) {
      nudges.push(loopNudge);
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

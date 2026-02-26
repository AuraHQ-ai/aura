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

// ── Circuit Breaker ─────────────────────────────────────────────────────────
// Catches semantic repetition: same tool + similar (not necessarily identical)
// args failing repeatedly. Complements the string-exact loop detection above.

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_WINDOW = 12;

const CIRCUIT_BREAKER_STOP =
  "Circuit breaker: {count} consecutive failures detected for {pattern}. " +
  "Stopping retries — this operation is failing consistently. " +
  "Do NOT attempt this operation again. " +
  "Explain the failure to the user and suggest alternatives or ask for help.";

const SEMANTIC_LOOP_WARNING =
  "WARNING: You appear to be in a semantic loop — you've called {toolName} " +
  "{count} times with nearly identical arguments (differing only in comments, " +
  "whitespace, or formatting). STOP and try a fundamentally different approach.";

interface TrackedToolCall {
  toolName: string;
  fingerprint: string;
  failed: boolean;
  errorFingerprint?: string;
}

/**
 * Normalize a shell command for semantic comparison:
 * strip comments, collapse whitespace, remove line continuations.
 */
function normalizeCommand(cmd: string): string {
  return cmd
    .replace(/\\[\r\n]+/g, " ")
    .replace(/(["'])(?:\\[\s\S]|(?!\1).)*\1|#[^\n]*/g, (match) =>
      match.startsWith("#") ? "" : match,
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract a semantic fingerprint from a shell command.
 * For curl/wget: method + base URL.
 * For other commands: first few significant tokens.
 */
function extractCommandFingerprint(cmd: string): string {
  const normalized = normalizeCommand(cmd);

  const curlUrlMatch = normalized.match(
    /curl\b.*?(https?:\/\/[^\s'"\\)]+)/,
  );
  if (curlUrlMatch) {
    const url = curlUrlMatch[1].split("?")[0];
    const methodMatch = normalized.match(/-X\s+(\w+)/i);
    const method = methodMatch?.[1]?.toUpperCase() || "GET";
    return `curl:${method}:${url}`;
  }

  const wgetMatch = normalized.match(/wget\b.*?(https?:\/\/[^\s'"\\)]+)/);
  if (wgetMatch) {
    return `wget:${wgetMatch[1].split("?")[0]}`;
  }

  return normalized.split(/\s+/).slice(0, 5).join(" ");
}

/**
 * Build a semantic fingerprint for any tool's arguments.
 * run_command gets special normalization; other tools use JSON.
 */
function normalizeToolArgs(toolName: string, args: unknown): string {
  if (toolName === "run_command" && args && typeof args === "object") {
    const { command } = args as { command?: string };
    if (typeof command === "string" && command) return extractCommandFingerprint(command);
  }
  try {
    return JSON.stringify(args) ?? "undefined";
  } catch {
    return String(args);
  }
}

/**
 * Simplify an error message into a comparable fingerprint
 * by lowercasing, replacing numbers, and collapsing whitespace.
 */
function extractErrorFingerprint(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const obj = output as Record<string, unknown>;
  let text = "";
  if (typeof obj.error === "string") text = obj.error;
  else if (typeof obj.stderr === "string") text = obj.stderr;
  else return undefined;
  if (!text) return undefined;
  return text
    .toLowerCase()
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Token-level Jaccard similarity — returns true when overlap >= 60%.
 */
function areSimilarFingerprints(a: string, b: string): boolean {
  if (a === b) return true;
  const tokensA = new Set(a.split(/[\s:\/]+/).filter(Boolean));
  const tokensB = new Set(b.split(/[\s:\/]+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 && intersection / union >= 0.6;
}

function checkCircuitBreaker(calls: TrackedToolCall[]): {
  tripped: boolean;
  count: number;
  pattern?: string;
  allFailed: boolean;
} {
  if (calls.length < CIRCUIT_BREAKER_THRESHOLD) {
    return { tripped: false, count: 0, allFailed: false };
  }

  const last = calls[calls.length - 1];

  // Count consecutive calls to the same tool with similar fingerprints
  let count = 0;
  let failCount = 0;
  for (let i = calls.length - 1; i >= 0; i--) {
    const entry = calls[i];
    if (entry.toolName !== last.toolName) break;
    if (!areSimilarFingerprints(entry.fingerprint, last.fingerprint)) break;
    count++;
    if (entry.failed) failCount++;
  }

  if (count >= CIRCUIT_BREAKER_THRESHOLD) {
    return {
      tripped: true,
      count,
      pattern: `${last.toolName}(${last.fingerprint.slice(0, 80)})`,
      allFailed: failCount === count,
    };
  }

  // Check for repeated error patterns across any tools
  if (last.failed && last.errorFingerprint) {
    let errorCount = 0;
    for (let i = calls.length - 1; i >= 0; i--) {
      const entry = calls[i];
      if (!entry.failed) break;
      if (!entry.errorFingerprint || !areSimilarFingerprints(entry.errorFingerprint, last.errorFingerprint)) break;
      errorCount++;
    }

    if (errorCount >= CIRCUIT_BREAKER_THRESHOLD) {
      return {
        tripped: true,
        count: errorCount,
        pattern: `repeated error: ${last.errorFingerprint.slice(0, 60)}`,
        allFailed: true,
      };
    }
  }

  return { tripped: false, count: 0, allFailed: false };
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
  const trackedCalls: TrackedToolCall[] = [];

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

    // --- Loop detection + circuit breaker: track recent tool calls ---
    if (lastStep?.toolCalls && Array.isArray(lastStep.toolCalls)) {
      const toolResults: any[] = lastStep.toolResults || [];
      const resultById = new Map<string, any>();
      for (const r of toolResults) {
        if (r.toolCallId) resultById.set(r.toolCallId, r);
      }

      for (let i = 0; i < lastStep.toolCalls.length; i++) {
        const tc = lastStep.toolCalls[i];
        const toolName = tc.toolName ?? tc.name ?? "unknown";
        const args = tc.input ?? tc.args;

        // Exact-match loop detection
        recentToolCalls.push({
          name: toolName,
          argsHash: hashArgs(args),
        });

        // Semantic circuit breaker tracking — only fall back to index when
        // the result at that position has no toolCallId (avoiding mis-association
        // if results arrive in a different order than calls).
        const resultByIndex = toolResults[i];
        const result = resultById.get(tc.toolCallId)
          ?? (resultByIndex && !resultByIndex.toolCallId ? resultByIndex : undefined);
        const output = result?.output ?? result?.result;
        const failed =
          output?.ok === false ||
          !!output?.error ||
          (toolName === "run_command" &&
            output?.exit_code != null &&
            output.exit_code !== 0);

        trackedCalls.push({
          toolName,
          fingerprint: normalizeToolArgs(toolName, args),
          failed,
          errorFingerprint: failed
            ? extractErrorFingerprint(output)
            : undefined,
        });
      }

      while (recentToolCalls.length > LOOP_WINDOW) {
        recentToolCalls.shift();
      }
      while (trackedCalls.length > CIRCUIT_BREAKER_WINDOW) {
        trackedCalls.shift();
      }
    }

    // --- Exact-match loop detection ---
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

    // --- Semantic circuit breaker (fires even when exact-match misses) ---
    let circuitBreakerNudge: string | undefined;
    if (!loopNudge) {
      const cbResult = checkCircuitBreaker(trackedCalls);
      if (cbResult.tripped) {
        if (cbResult.allFailed) {
          circuitBreakerNudge = CIRCUIT_BREAKER_STOP
            .replace("{count}", String(cbResult.count))
            .replace("{pattern}", cbResult.pattern || "unknown");
        } else {
          circuitBreakerNudge = SEMANTIC_LOOP_WARNING
            .replace("{toolName}", cbResult.pattern?.split("(")[0] || "a tool")
            .replace("{count}", String(cbResult.count));
        }
        logger.warn("prepareStep: circuit breaker tripped", {
          stepNumber,
          pattern: cbResult.pattern,
          count: cbResult.count,
          allFailed: cbResult.allFailed,
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

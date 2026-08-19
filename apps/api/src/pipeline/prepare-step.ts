import { pruneMessages } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { compactMessages } from "./compact-messages.js";
import { getModelCapabilities } from "../lib/model-catalog.js";
import { isInvocationCurrent } from "../lib/invocation-lock.js";
import { logger } from "../lib/logger.js";
import { logError } from "../lib/error-logger.js";
import {
  spawnTurnContinuationJob,
  type TurnDeadlinePath,
  type TurnDeadlines,
} from "./turn-deadline.js";
import type { ModelCapabilities } from "@aura/db/schema";

export class InvocationSupersededError extends Error {
  constructor(public readonly invocationId: string) {
    super(`Invocation ${invocationId} was superseded by a newer message`);
    this.name = "InvocationSupersededError";
  }
}

export const STEP_LIMIT = 250;
export const HEADLESS_STEP_LIMIT = 350;
const WARNING_THRESHOLD = 200;
const HEADLESS_WARNING_THRESHOLD = 300;

export const WRAP_UP_MESSAGE =
  "IMPORTANT: You're approaching your step limit ({stepCount}/{limit}). " +
  "Start wrapping up — summarize your findings and post results now. " +
  "Do not start new investigations or long tool chains.";

// ── Turn wall-clock deadline messages (issue #1318) ──────────────────────────
// Exported so the durable WDK path (workflows/slack-respond.ts) reuses the
// exact same nudges instead of duplicating the strings (issue #1320).

export const TURN_SOFT_DEADLINE_MESSAGE =
  "IMPORTANT: This turn has been running for {elapsedSec}s and is approaching " +
  "the platform's wall-clock limit. Wrap up NOW: do not start new " +
  "investigations or long tool calls, summarize what you have done so far, " +
  "and if work remains use checkpoint_plan to save your progress and " +
  "schedule a continuation.";

export const TURN_HARD_DEADLINE_MESSAGE_WITH_CONTINUATION =
  "CRITICAL: This turn's wall-clock budget is exhausted and your tools have " +
  "been withdrawn. Reply now with your final message: state what you " +
  "completed and what remains. A continuation job has already been scheduled " +
  "to resume the remaining work in this thread — hand off cleanly and keep " +
  "it brief.";

export const TURN_HARD_DEADLINE_MESSAGE_WITHOUT_CONTINUATION =
  "CRITICAL: This turn's wall-clock budget is exhausted and your tools have " +
  "been withdrawn. Reply now with your final message: state what you " +
  "completed, what remains, and tell the user they can ask you to resume " +
  "the remaining work.";

export type EffortLevel = "low" | "medium" | "high";

/** Per-step compaction stats reported via `recordCompaction` (issue #1328). */
export interface CompactionStepStats {
  stepNumber: number;
  compactedCount: number;
  estimatedTokensSaved: number;
}

type PrepareStepResult = {
  system?: string;
  instructions?: string;
  providerOptions?: ProviderOptions;
  model?: LanguageModel;
  messages?: Array<ModelMessage>;
  /** Empty past the hard turn deadline so the model must emit final text. */
  activeTools?: ReadonlyArray<never>;
  toolChoice?: "auto" | "none" | "required";
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
 * Handles:
 * 1. Thinking: enables extended thinking with `budgetTokens` on any model
 *    whose gateway catalog entry carries the `reasoning` tag. No model ID
 *    parsing — the AI Gateway tells us which models support thinking.
 * 2. Model escalation: after repeated tool failures, swaps to the escalation
 *    model (typically Sonnet → Opus).
 * 3. Step limit warning: injects a system-level wrap-up nudge near the step
 *    limit.
 *
 * `defaultEffort` is accepted for backwards compatibility but currently
 * ignored — we rely on the model's own adaptive behavior.
 */

function isAnthropicGatewayModel(modelId: string): boolean {
  return modelId.startsWith("anthropic/") || modelId.startsWith("claude");
}

function hasProviderOptions(options: ProviderOptions): boolean {
  return Object.keys(options).length > 0;
}

export function resolveProviderThinkingOptions(
  modelId: string,
  capabilities: ModelCapabilities | null,
  budgetTokens: number,
  catalogState?: { found: boolean; supportsThinking: boolean },
): ProviderOptions {
  if (!capabilities) {
    // Preserve historical Anthropic behavior while allowing the catalog probe
    // or runtime self-heal to write the more precise mode back later.
    if (
      isAnthropicGatewayModel(modelId) &&
      (catalogState?.supportsThinking || catalogState?.found === false)
    ) {
      return {
        anthropic: {
          thinking: { type: "enabled", budgetTokens },
        },
      } as ProviderOptions;
    }
    return {};
  }

  switch (capabilities.provider) {
    case "anthropic":
      if (capabilities.thinkingMode === "none") return {};
      return {
        anthropic: {
          thinking: capabilities.thinkingMode === "adaptive"
            ? { type: "adaptive" }
            : { type: "enabled", budgetTokens },
        },
      } as ProviderOptions;
    case "openai":
      if (capabilities.reasoningEffort === "none") return {};
      return {
        openai: {
          reasoningEffort: capabilities.reasoningEffort,
        },
      } as ProviderOptions;
    case "google":
      if (capabilities.thinkingBudget === "none") return {};
      return {
        google: {
          thinkingConfig: {
            thinkingBudget: capabilities.thinkingBudget === "dynamic"
              ? -1
              : capabilities.thinkingBudget,
          },
        },
      } as ProviderOptions;
    case "xai":
      if (capabilities.reasoningEffort === "none") return {};
      return {
        xai: {
          reasoningEffort: capabilities.reasoningEffort,
        },
      } as ProviderOptions;
    case "none":
      return {};
  }

  return {};
}

export async function getProviderThinkingOptions(
  modelId: string,
  budgetTokens: number,
): Promise<ProviderOptions> {
  const catalogCapabilities = await getModelCapabilities(modelId);
  return resolveProviderThinkingOptions(
    modelId,
    catalogCapabilities.capabilities,
    budgetTokens,
    {
      found: catalogCapabilities.found,
      supportsThinking: catalogCapabilities.supportsThinking,
    },
  );
}

export function createPrepareStep(opts: {
  stepLimit?: number;
  warningThreshold?: number;
  stablePrefix: string;
  environmentContext?: string;
  conversationContext?: string;
  dynamicContext?: string;
  defaultEffort?: EffortLevel;
  modelId?: string;
  thinkingBudget?: number;
  getEscalationModel?: () => Promise<{ modelId: string; model: LanguageModel }>;
  recordStepModelId?: (stepNumber: number, modelId?: string) => void;
  /**
   * Called on each step where compaction replaced at least one old tool
   * result (issue #1328). Callers accumulate per-turn totals for the
   * conversation_traces row; the persisted trace itself stays untouched.
   */
  recordCompaction?: (stats: CompactionStepStats) => void;
  invocationId?: string;
  channelId?: string;
  threadTs?: string;
  userId?: string;
  /** Wall-clock budget for the turn (issue #1318). Omit to disable. */
  turnDeadlines?: TurnDeadlines;
  /** Pipeline path label for deadline telemetry. */
  turnPath?: TurnDeadlinePath;
  /**
   * Continuation depth of the CURRENT turn (issue #1320): 0 for an original
   * turn, N for a job resumed from a `[CONTINUE:topic:dN]` tag. A hard
   * deadline spawns the next continuation at depth N + 1, capped at
   * MAX_CONTINUATION_DEPTH inside spawnTurnContinuationJob.
   */
  continuationDepth?: number;
}): PrepareStepFn {
  const limit = opts.stepLimit ?? STEP_LIMIT;
  const threshold = opts.warningThreshold ?? WARNING_THRESHOLD;
  let hasEscalatedModel = false;
  let escalatedModel: { modelId: string; model: LanguageModel } | null = null;
  let failureCount = 0;

  // ── Turn wall-clock deadline state (issue #1318) ──────────────────────────
  // turnStartedAt is recorded ONCE here, alongside the rest of the per-turn
  // counters, when the prepareStep closure is created at the start of the
  // turn. It is never re-derived per step.
  const turnStartedAt = Date.now();
  const softDeadlineMs = opts.turnDeadlines?.softDeadlineMs;
  const hardDeadlineMs = opts.turnDeadlines?.hardDeadlineMs;
  let softDeadlineNudgeInjected = false;
  let hardDeadlineTripped = false;
  let continuationJobSpawned = false;

  // Cache providerOptions per model/budget for this prepareStep instance.
  // Catalog lookups are also in-memory cached, but this avoids repeated work
  // while a long multi-step response is running.
  const thinkingOptionsCache = new Map<string, ProviderOptions>();
  async function getCachedProviderThinkingOptions(
    modelId: string | undefined,
    budgetTokens: number | undefined,
  ): Promise<ProviderOptions | undefined> {
    if (!modelId || !budgetTokens) return undefined;
    const cacheKey = `${modelId}::${budgetTokens}`;
    const hit = thinkingOptionsCache.get(cacheKey);
    if (hit) return hasProviderOptions(hit) ? hit : undefined;

    try {
      const options = await getProviderThinkingOptions(modelId, budgetTokens);
      thinkingOptionsCache.set(cacheKey, options);
      return hasProviderOptions(options) ? options : undefined;
    } catch (err: any) {
      logger.warn("prepareStep: capability lookup failed", {
        modelId,
        error: err?.message,
      });
      thinkingOptionsCache.set(cacheKey, {});
      return undefined;
    }
  }

  return async ({ stepNumber, steps, messages }) => {
    // --- Invocation staleness check (abort if superseded) ---
    if (opts.invocationId && opts.channelId && opts.threadTs) {
      let stillCurrent = true;
      try {
        stillCurrent = await isInvocationCurrent(opts.channelId, opts.threadTs, opts.invocationId);
      } catch (err: any) {
        logger.warn("Invocation check failed, assuming still current", {
          invocationId: opts.invocationId,
          error: err?.message,
          stepNumber,
        });
      }
      if (!stillCurrent) {
        logger.info("Invocation superseded — aborting", {
          invocationId: opts.invocationId,
          channelId: opts.channelId,
          threadTs: opts.threadTs,
          stepNumber,
        });
        throw new InvocationSupersededError(opts.invocationId);
      }
    }

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

    // --- Model escalation: persistent failures → escalation model ---
    if (
      stepNumber > 15 &&
      failureCount >= 3 &&
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

    // Effective model may have changed via escalation; look up its thinking
    // support via the gateway-sourced catalog (tags.includes("reasoning")).
    const effectiveModelId = (hasEscalatedModel && escalatedModel) ? escalatedModel.modelId : opts.modelId;
    opts.recordStepModelId?.(stepNumber, effectiveModelId);
    providerOptions = await getCachedProviderThinkingOptions(effectiveModelId, opts.thinkingBudget);

    // --- Turn wall-clock deadline (issue #1318) ---
    // The step budget never binds in practice (turns die around step 40 while
    // the limit is 250) because sandbox tool calls cost 40-150s each. Enforce
    // a wall-clock budget so the turn wraps up BEFORE the Vercel maxDuration
    // (800s) SIGKILL instead of dying mid-sentence.
    const elapsedMs = Date.now() - turnStartedAt;
    const hardDeadlineActive = hardDeadlineMs != null && elapsedMs >= hardDeadlineMs;
    const systemSuffixes: string[] = [];

    if (hardDeadlineActive && !hardDeadlineTripped) {
      hardDeadlineTripped = true;
      logger.warn("prepareStep: turn hard deadline tripped — withdrawing tools", {
        elapsedMs,
        hardDeadlineMs,
        stepNumber,
      });
      logError({
        errorName: "TurnHardDeadline",
        errorMessage: `Turn exceeded its hard wall-clock deadline (${hardDeadlineMs}ms); tools withdrawn to force a final message`,
        errorCode: "turn_hard_deadline",
        channelId: opts.channelId,
        userId: opts.userId,
        context: { elapsedMs, step: stepNumber, path: opts.turnPath },
      });
      // Auto-spawn a continuation job so the unfinished work resumes in the
      // same Slack thread. Awaited so the row exists before the SIGKILL;
      // fail-soft (returns false) so it can never break the wrap-up step.
      continuationJobSpawned = await spawnTurnContinuationJob({
        channelId: opts.channelId,
        threadTs: opts.threadTs,
        userId: opts.userId,
        invocationId: opts.invocationId,
        elapsedMs,
        step: stepNumber,
        depth: (opts.continuationDepth ?? 0) + 1,
      });
    }

    if (hardDeadlineActive) {
      systemSuffixes.push(
        continuationJobSpawned
          ? TURN_HARD_DEADLINE_MESSAGE_WITH_CONTINUATION
          : TURN_HARD_DEADLINE_MESSAGE_WITHOUT_CONTINUATION,
      );
    } else if (
      softDeadlineMs != null &&
      elapsedMs >= softDeadlineMs &&
      !softDeadlineNudgeInjected
    ) {
      // Soft deadline: inject the wrap-up nudge at most ONCE per turn. The
      // instructions override carries forward to later steps in the AI SDK,
      // so a single injection keeps the nudge in play.
      softDeadlineNudgeInjected = true;
      logger.warn("prepareStep: turn soft deadline reached — injecting wrap-up nudge", {
        elapsedMs,
        softDeadlineMs,
        stepNumber,
      });
      logError({
        errorName: "TurnSoftDeadline",
        errorMessage: `Turn exceeded its soft wall-clock deadline (${softDeadlineMs}ms); wrap-up nudge injected`,
        errorCode: "turn_soft_deadline",
        channelId: opts.channelId,
        userId: opts.userId,
        context: { elapsedMs, step: stepNumber, path: opts.turnPath },
      });
      systemSuffixes.push(
        TURN_SOFT_DEADLINE_MESSAGE.replace(
          "{elapsedSec}",
          String(Math.round(elapsedMs / 1000)),
        ),
      );
    }

    // --- Step limit warning ---
    if (stepNumber >= threshold) {
      systemSuffixes.push(
        WRAP_UP_MESSAGE
          .replace("{stepCount}", String(stepNumber))
          .replace("{limit}", String(limit)),
      );
      logger.info("prepareStep: injecting wrap-up nudge", {
        stepNumber,
        limit,
      });
    }

    // Concatenates all layers into a single string override. This breaks
    // cache for the affected steps only — acceptable tradeoff since these
    // nudges fire near the end of a turn.
    if (systemSuffixes.length > 0) {
      systemOverride = opts.stablePrefix
        + (opts.environmentContext ? "\n\n" + opts.environmentContext : "")
        + (opts.conversationContext ? "\n\n" + opts.conversationContext : "")
        + (opts.dynamicContext ? "\n\n" + opts.dynamicContext : "")
        + "\n\n" + systemSuffixes.join("\n\n");
    }

    // --- Context compaction (issue #1328) ---
    // Applied universally (interactive AND headless): past the step threshold,
    // old large tool results are replaced with stubs that KEEP toolCallId +
    // toolName, so the model still sees what it already did (no #499 re-run
    // loops) and no tool-call is orphaned from its tool-result. Only the
    // in-flight array is modified — the persisted trace stays complete.
    const compaction = compactMessages(messages, stepNumber);
    if (compaction.compactedCount > 0) {
      logger.info("prepareStep: compacting messages", {
        stepNumber,
        totalMessages: messages.length,
        compactedCount: compaction.compactedCount,
        estimatedTokensSaved: compaction.estimatedTokensSaved,
      });
      opts.recordCompaction?.({
        stepNumber,
        compactedCount: compaction.compactedCount,
        estimatedTokensSaved: compaction.estimatedTokensSaved,
      });
    }

    const prunedMessages = pruneMessages({
      messages: compaction.messages,
      reasoning: "before-last-message",
    });

    return {
      messages: prunedMessages,
      ...(systemOverride && { instructions: systemOverride }),
      ...(providerOptions && { providerOptions }),
      ...(modelOverride && { model: modelOverride }),
      // Past the hard deadline, stop offering tools so the model is forced
      // to emit a final text message in the remaining headroom.
      ...(hardDeadlineActive && { activeTools: [] as const, toolChoice: "none" as const }),
    };
  };
}

/** Factory for interactive Slack agent prepareStep (250-step limit, with context compaction). */
export function createInteractivePrepareStep(opts: {
  stablePrefix: string;
  environmentContext?: string;
  conversationContext?: string;
  dynamicContext?: string;
  modelId?: string;
  defaultEffort?: EffortLevel;
  thinkingBudget?: number;
  getEscalationModel?: () => Promise<{ modelId: string; model: LanguageModel }>;
  recordStepModelId?: (stepNumber: number, modelId?: string) => void;
  recordCompaction?: (stats: CompactionStepStats) => void;
  invocationId?: string;
  channelId?: string;
  threadTs?: string;
  userId?: string;
  /** Wall-clock budget for the turn (issue #1318). Omit to disable. */
  turnDeadlines?: TurnDeadlines;
}): PrepareStepFn {
  return createPrepareStep({
    stepLimit: STEP_LIMIT,
    warningThreshold: WARNING_THRESHOLD,
    stablePrefix: opts.stablePrefix,
    environmentContext: opts.environmentContext,
    conversationContext: opts.conversationContext,
    dynamicContext: opts.dynamicContext,
    modelId: opts.modelId,
    defaultEffort: opts.defaultEffort,
    thinkingBudget: opts.thinkingBudget,
    getEscalationModel: opts.getEscalationModel,
    recordStepModelId: opts.recordStepModelId,
    recordCompaction: opts.recordCompaction,
    invocationId: opts.invocationId,
    channelId: opts.channelId,
    threadTs: opts.threadTs,
    userId: opts.userId,
    turnDeadlines: opts.turnDeadlines,
    turnPath: "interactive",
  });
}

/** Factory for headless job execution prepareStep (350-step limit, with context compaction). */
export function createHeadlessPrepareStep(opts: {
  stablePrefix: string;
  environmentContext?: string;
  conversationContext?: string;
  dynamicContext?: string;
  modelId?: string;
  defaultEffort?: EffortLevel;
  thinkingBudget?: number;
  getEscalationModel?: () => Promise<{ modelId: string; model: LanguageModel }>;
  recordStepModelId?: (stepNumber: number, modelId?: string) => void;
  recordCompaction?: (stats: CompactionStepStats) => void;
  invocationId?: string;
  channelId?: string;
  threadTs?: string;
  userId?: string;
  /** Wall-clock budget for the turn (issue #1318). Omit to disable. */
  turnDeadlines?: TurnDeadlines;
  /** Continuation depth of the current job (issue #1320); 0 when not a continuation. */
  continuationDepth?: number;
}): PrepareStepFn {
  return createPrepareStep({
    stepLimit: HEADLESS_STEP_LIMIT,
    warningThreshold: HEADLESS_WARNING_THRESHOLD,
    stablePrefix: opts.stablePrefix,
    environmentContext: opts.environmentContext,
    conversationContext: opts.conversationContext,
    dynamicContext: opts.dynamicContext,
    modelId: opts.modelId,
    defaultEffort: opts.defaultEffort,
    thinkingBudget: opts.thinkingBudget,
    getEscalationModel: opts.getEscalationModel,
    recordStepModelId: opts.recordStepModelId,
    recordCompaction: opts.recordCompaction,
    invocationId: opts.invocationId,
    channelId: opts.channelId,
    threadTs: opts.threadTs,
    userId: opts.userId,
    turnDeadlines: opts.turnDeadlines,
    turnPath: "headless",
    continuationDepth: opts.continuationDepth,
  });
}

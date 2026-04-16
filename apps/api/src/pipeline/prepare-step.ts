import { pruneMessages } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { isAnthropicModel } from "../lib/ai.js";
import { getModelCapabilities } from "../lib/model-catalog.js";
import { isInvocationCurrent } from "../lib/invocation-lock.js";
import { logger } from "../lib/logger.js";

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

const WRAP_UP_MESSAGE =
  "IMPORTANT: You're approaching your step limit ({stepCount}/{limit}). " +
  "Start wrapping up — summarize your findings and post results now. " +
  "Do not start new investigations or long tool chains.";

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

/**
 * Some Anthropic models only support adaptive thinking (self-managed budget),
 * not the classic `{ type: "enabled", budgetTokens }` API. Opus 4.7 is the
 * first such model. Sending `enabled` to an adaptive-only model causes the
 * direct Anthropic API to reject the request, producing
 * `AI_NoOutputGeneratedError` with an empty stream.
 *
 * The gateway catalog only exposes a single `reasoning` tag and doesn't
 * distinguish the two thinking modes, so we keep a small allowlist of
 * adaptive-only gateway IDs. When more land, add them here.
 */
const ADAPTIVE_ONLY_THINKING_MODELS = new Set<string>([
  "anthropic/claude-opus-4.7",
]);

function getAnthropicThinkingOptions(
  modelId: string,
  budgetTokens: number,
): { type: "adaptive" } | { type: "enabled"; budgetTokens: number } {
  if (ADAPTIVE_ONLY_THINKING_MODELS.has(modelId)) {
    return { type: "adaptive" };
  }
  return { type: "enabled", budgetTokens };
}

export function createPrepareStep(opts: {
  stepLimit?: number;
  warningThreshold?: number;
  stablePrefix: string;
  conversationContext?: string;
  dynamicContext?: string;
  defaultEffort?: EffortLevel;
  modelId?: string;
  thinkingBudget?: number;
  getEscalationModel?: () => Promise<{ modelId: string; model: LanguageModel }>;
  recordStepModelId?: (stepNumber: number, modelId?: string) => void;
  invocationId?: string;
  channelId?: string;
  threadTs?: string;
}): PrepareStepFn {
  const limit = opts.stepLimit ?? STEP_LIMIT;
  const threshold = opts.warningThreshold ?? WARNING_THRESHOLD;
  let hasEscalatedModel = false;
  let escalatedModel: { modelId: string; model: LanguageModel } | null = null;
  let failureCount = 0;

  // Cache thinking support per model ID for this prepareStep instance.
  // Catalog lookups are already in-memory-cached (5 min TTL), but we also
  // memoize here so we don't hit the cache on every step.
  const thinkingCache = new Map<string, boolean>();
  async function modelSupportsThinking(modelId: string | undefined): Promise<boolean> {
    if (!modelId) return false;
    if (!isAnthropicModel(modelId)) return false;
    const hit = thinkingCache.get(modelId);
    if (hit !== undefined) return hit;
    try {
      const caps = await getModelCapabilities(modelId);
      thinkingCache.set(modelId, caps.supportsThinking);
      return caps.supportsThinking;
    } catch (err: any) {
      logger.warn("prepareStep: capability lookup failed", {
        modelId,
        error: err?.message,
      });
      thinkingCache.set(modelId, false);
      return false;
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
    const thinkingEnabled = await modelSupportsThinking(effectiveModelId);

    // --- Build Anthropic provider options ---
    if (thinkingEnabled && opts.thinkingBudget && effectiveModelId) {
      providerOptions = {
        anthropic: {
          thinking: getAnthropicThinkingOptions(effectiveModelId, opts.thinkingBudget),
        },
      };
    }

    // --- Step limit warning ---
    // Concatenates all layers into a single string override. This breaks
    // cache for the wrap-up step only — acceptable tradeoff since it fires
    // near the step limit (≥200) and only once per conversation.
    if (stepNumber >= threshold) {
      const wrapUp = WRAP_UP_MESSAGE
        .replace("{stepCount}", String(stepNumber))
        .replace("{limit}", String(limit));
      systemOverride = opts.stablePrefix
        + (opts.conversationContext ? "\n\n" + opts.conversationContext : "")
        + (opts.dynamicContext ? "\n\n" + opts.dynamicContext : "")
        + "\n\n" + wrapUp;
      logger.info("prepareStep: injecting wrap-up nudge", {
        stepNumber,
        limit,
      });
    }

    const prunedMessages = pruneMessages({
      messages,
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
  stablePrefix: string;
  conversationContext?: string;
  dynamicContext?: string;
  modelId?: string;
  defaultEffort?: EffortLevel;
  thinkingBudget?: number;
  getEscalationModel?: () => Promise<{ modelId: string; model: LanguageModel }>;
  recordStepModelId?: (stepNumber: number, modelId?: string) => void;
  invocationId?: string;
  channelId?: string;
  threadTs?: string;
}): PrepareStepFn {
  return createPrepareStep({
    stepLimit: STEP_LIMIT,
    warningThreshold: WARNING_THRESHOLD,
    stablePrefix: opts.stablePrefix,
    conversationContext: opts.conversationContext,
    dynamicContext: opts.dynamicContext,
    modelId: opts.modelId,
    defaultEffort: opts.defaultEffort,
    thinkingBudget: opts.thinkingBudget,
    getEscalationModel: opts.getEscalationModel,
    recordStepModelId: opts.recordStepModelId,
    invocationId: opts.invocationId,
    channelId: opts.channelId,
    threadTs: opts.threadTs,
  });
}

/** Factory for headless job execution prepareStep (350-step limit). */
export function createHeadlessPrepareStep(opts: {
  stablePrefix: string;
  conversationContext?: string;
  dynamicContext?: string;
  modelId?: string;
  defaultEffort?: EffortLevel;
  thinkingBudget?: number;
  getEscalationModel?: () => Promise<{ modelId: string; model: LanguageModel }>;
  recordStepModelId?: (stepNumber: number, modelId?: string) => void;
  invocationId?: string;
  channelId?: string;
  threadTs?: string;
}): PrepareStepFn {
  return createPrepareStep({
    stepLimit: HEADLESS_STEP_LIMIT,
    warningThreshold: HEADLESS_WARNING_THRESHOLD,
    stablePrefix: opts.stablePrefix,
    conversationContext: opts.conversationContext,
    dynamicContext: opts.dynamicContext,
    modelId: opts.modelId,
    defaultEffort: opts.defaultEffort,
    thinkingBudget: opts.thinkingBudget,
    getEscalationModel: opts.getEscalationModel,
    recordStepModelId: opts.recordStepModelId,
    invocationId: opts.invocationId,
    channelId: opts.channelId,
    threadTs: opts.threadTs,
  });
}

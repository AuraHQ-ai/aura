import { pruneMessages } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { getModelCapabilities } from "../lib/model-catalog.js";
import { isInvocationCurrent } from "../lib/invocation-lock.js";
import { logger } from "../lib/logger.js";
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
  invocationId?: string;
  channelId?: string;
  threadTs?: string;
}): PrepareStepFn {
  const limit = opts.stepLimit ?? STEP_LIMIT;
  const threshold = opts.warningThreshold ?? WARNING_THRESHOLD;
  let hasEscalatedModel = false;
  let escalatedModel: { modelId: string; model: LanguageModel } | null = null;
  let failureCount = 0;

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

    // --- Step limit warning ---
    // Concatenates all layers into a single string override. This breaks
    // cache for the wrap-up step only — acceptable tradeoff since it fires
    // near the step limit (≥200) and only once per conversation.
    if (stepNumber >= threshold) {
      const wrapUp = WRAP_UP_MESSAGE
        .replace("{stepCount}", String(stepNumber))
        .replace("{limit}", String(limit));
      systemOverride = opts.stablePrefix
        + (opts.environmentContext ? "\n\n" + opts.environmentContext : "")
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
  environmentContext?: string;
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
    environmentContext: opts.environmentContext,
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
  environmentContext?: string;
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
    environmentContext: opts.environmentContext,
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

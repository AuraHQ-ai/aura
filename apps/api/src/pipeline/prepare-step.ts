import { pruneMessages } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { supportsEffort, supportsAdaptiveThinking, supportsThinking } from "../lib/ai.js";
import { logger } from "../lib/logger.js";

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
 * 1. Effort escalation (Anthropic only): starts at defaultEffort (usually "medium"),
 *    bumps to "high" when the agent is deep into a task or hitting tool failures,
 *    and optionally escalates the model from Sonnet to Opus for persistent failures.
 * 2. Step limit warning: injects a system-level wrap-up nudge near the step limit.
 */
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
}): PrepareStepFn {
  const limit = opts.stepLimit ?? STEP_LIMIT;
  const threshold = opts.warningThreshold ?? WARNING_THRESHOLD;
  const hasEffortSupport = opts.modelId ? supportsEffort(opts.modelId) : false;
  let currentEffort: EffortLevel = opts.defaultEffort ?? "medium";
  let hasEscalatedModel = false;
  let escalatedModel: { modelId: string; model: LanguageModel } | null = null;
  let failureCount = 0;

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

    // --- Effort escalation (runs first so currentEffort is up to date for model escalation) ---
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
    }

    // --- Model escalation: persistent failures → escalation model ---
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

    // Recompute capability flags for the effective model (may differ after escalation)
    const effectiveModelId = (hasEscalatedModel && escalatedModel) ? escalatedModel.modelId : opts.modelId;
    const activeHasEffortSupport = effectiveModelId ? supportsEffort(effectiveModelId) : false;
    const activeHasAdaptiveThinking = effectiveModelId ? supportsAdaptiveThinking(effectiveModelId) : false;
    const activeHasThinkingSupport = effectiveModelId ? supportsThinking(effectiveModelId) : false;

    // --- Build Anthropic provider options (thinking + effort) ---
    const anthropicOpts: Record<string, any> = {};
    if (activeHasAdaptiveThinking) {
      anthropicOpts.thinking = { type: "adaptive" };
    } else if (activeHasThinkingSupport && opts.thinkingBudget) {
      anthropicOpts.thinking = { type: "enabled", budgetTokens: opts.thinkingBudget };
    }
    if (activeHasEffortSupport) {
      anthropicOpts.effort = currentEffort;
    }
    if (Object.keys(anthropicOpts).length > 0) {
      providerOptions = { anthropic: anthropicOpts };
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
  });
}

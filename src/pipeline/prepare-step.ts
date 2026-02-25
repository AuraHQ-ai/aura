import type { LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { supportsEffort } from "../lib/ai.js";
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
} | undefined;

type PrepareStepFn = (options: {
  stepNumber: number;
  steps: Array<any>;
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
  defaultEffort?: EffortLevel;
  modelId?: string;
  getEscalationModel?: () => Promise<LanguageModel>;
}): PrepareStepFn {
  const limit = opts.stepLimit ?? STEP_LIMIT;
  const threshold = opts.warningThreshold ?? WARNING_THRESHOLD;
  const isAnthropic = opts.modelId ? supportsEffort(opts.modelId) : false;
  let currentEffort: EffortLevel = opts.defaultEffort ?? "medium";
  let hasEscalatedModel = false;
  let escalatedModel: LanguageModel | null = null;

  return async ({ stepNumber, steps }) => {
    let systemOverride: string | undefined;
    let providerOptions: ProviderOptions | undefined;
    let modelOverride: LanguageModel | undefined;

    // --- Effort escalation (Anthropic only) ---
    if (isAnthropic) {
      const lastStep = Array.isArray(steps) && steps.length > 0
        ? steps[steps.length - 1]
        : null;

      const hadToolFailure = lastStep?.toolResults?.some(
        (r: any) => r.output?.ok === false || r.output?.error,
      ) ?? false;

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

      providerOptions = { anthropic: { effort: currentEffort } };

      // --- Model escalation: deep into task + still failing at high effort → Opus ---
      if (
        stepNumber > 15 &&
        hadToolFailure &&
        currentEffort === "high" &&
        !hasEscalatedModel &&
        opts.getEscalationModel
      ) {
        try {
          escalatedModel = await opts.getEscalationModel();
          hasEscalatedModel = true;
          modelOverride = escalatedModel;
          logger.warn("prepareStep: escalating model to Opus", { stepNumber });
        } catch (err: any) {
          logger.error("prepareStep: failed to load escalation model", {
            stepNumber,
            error: err?.message,
          });
        }
      }

      if (hasEscalatedModel && escalatedModel && !modelOverride) {
        modelOverride = escalatedModel;
      }
    }

    // --- Step limit warning (existing behavior) ---
    if (stepNumber >= threshold) {
      const nudge = WRAP_UP_MESSAGE
        .replace("{stepCount}", String(stepNumber))
        .replace("{limit}", String(limit));

      systemOverride = opts.systemPrompt + "\n\n" + nudge;
      logger.info("prepareStep: injecting wrap-up nudge", {
        stepNumber,
        limit,
      });
    }

    const hasOverrides = systemOverride || providerOptions || modelOverride;
    if (!hasOverrides) return undefined;

    return {
      ...(systemOverride && { system: systemOverride }),
      ...(providerOptions && { providerOptions }),
      ...(modelOverride && { model: modelOverride }),
    };
  };
}

/** Factory for interactive Slack agent prepareStep (250-step limit). */
export function createInteractivePrepareStep(opts: {
  systemPrompt: string;
  modelId?: string;
  defaultEffort?: EffortLevel;
  getEscalationModel?: () => Promise<LanguageModel>;
}): PrepareStepFn {
  return createPrepareStep({
    stepLimit: STEP_LIMIT,
    warningThreshold: WARNING_THRESHOLD,
    systemPrompt: opts.systemPrompt,
    modelId: opts.modelId,
    defaultEffort: opts.defaultEffort,
    getEscalationModel: opts.getEscalationModel,
  });
}

/** Factory for headless job execution prepareStep (350-step limit). */
export function createHeadlessPrepareStep(opts: {
  systemPrompt: string;
  modelId?: string;
  defaultEffort?: EffortLevel;
  getEscalationModel?: () => Promise<LanguageModel>;
}): PrepareStepFn {
  return createPrepareStep({
    stepLimit: HEADLESS_STEP_LIMIT,
    warningThreshold: HEADLESS_WARNING_THRESHOLD,
    systemPrompt: opts.systemPrompt,
    modelId: opts.modelId,
    defaultEffort: opts.defaultEffort,
    getEscalationModel: opts.getEscalationModel,
  });
}

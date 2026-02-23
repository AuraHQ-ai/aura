import { logger } from "../lib/logger.js";

const STEP_LIMIT = 250;
const HEADLESS_STEP_LIMIT = 350;
const WARNING_THRESHOLD = 200;
const HEADLESS_WARNING_THRESHOLD = 300;

const WRAP_UP_MESSAGE =
  "IMPORTANT: You're approaching your step limit ({stepCount}/{limit}). " +
  "Start wrapping up — summarize your findings and post results now. " +
  "Do not start new investigations or long tool chains.";

/**
 * Narrow return type for our prepareStep — we only ever override `system`.
 * This avoids generic ToolChoice variance issues with strongly-typed tool sets.
 */
type StepOverride = { system: string } | undefined;

type PrepareStepFn = (options: {
  stepNumber: number;
  [key: string]: unknown;
}) => StepOverride;

/**
 * Build a `prepareStep` callback for AI SDK's streamText/generateText.
 *
 * Injects a system-level nudge when the agent is approaching its step limit,
 * giving it a chance to wrap up gracefully instead of being hard-cut.
 */
export function createPrepareStep(opts?: {
  stepLimit?: number;
  warningThreshold?: number;
}): PrepareStepFn {
  const limit = opts?.stepLimit ?? STEP_LIMIT;
  const threshold = opts?.warningThreshold ?? WARNING_THRESHOLD;

  return ({ stepNumber }) => {
    if (stepNumber >= threshold) {
      const message = WRAP_UP_MESSAGE
        .replace("{stepCount}", String(stepNumber))
        .replace("{limit}", String(limit));

      logger.info("prepareStep: injecting wrap-up nudge", {
        stepNumber,
        limit,
      });

      return { system: message };
    }
    return undefined;
  };
}

/** Pre-built prepareStep for the interactive Slack agent (250-step limit). */
export const interactivePrepareStep = createPrepareStep({
  stepLimit: STEP_LIMIT,
  warningThreshold: WARNING_THRESHOLD,
});

/** Pre-built prepareStep for headless job execution (350-step limit). */
export const headlessPrepareStep = createPrepareStep({
  stepLimit: HEADLESS_STEP_LIMIT,
  warningThreshold: HEADLESS_WARNING_THRESHOLD,
});

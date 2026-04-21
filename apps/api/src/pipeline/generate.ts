import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type UIMessage,
  type StepResult,
  type LanguageModelUsage,
} from "ai";
import { createInteractivePrepareStep } from "./prepare-step.js";
import { buildCachedSystemMessages, getEscalationModel } from "../lib/ai.js";

/**
 * Channel-agnostic agentic stream.
 *
 * Encapsulates the full LLM call with prepareStep middleware:
 * - Adaptive thinking / extended thinking
 * - Effort escalation (low → medium → high)
 * - Model escalation (e.g. Sonnet → Opus on persistent failures)
 * - Step limits with wrap-up warnings
 * - Message pruning (reasoning trimming)
 * - Invocation staleness checks
 *
 * Channel connectors (Slack, Dashboard, etc.) call this and handle
 * delivery in their own way. They MUST NOT configure model behavior
 * directly — all LLM intelligence lives here.
 */
export interface AgenticStreamOptions {
  model: LanguageModel;
  modelId: string;
  tools: Record<string, any>;
  stablePrefix: string;
  conversationContext: string;
  dynamicContext: string;
  messages: ModelMessage[];
  maxSteps?: number;
  thinkingBudget?: number;
  userId?: string;
  channelId?: string;
  threadTs?: string;
  invocationId?: string;
  onFinish?: (event: {
    steps: StepResult<any>[];
    stepModelIds: string[];
    totalUsage: LanguageModelUsage;
    text: string;
  }) => void;
}

export function createAgenticStream(options: AgenticStreamOptions) {
  const stepModelIds: string[] = [];
  const prepareStep = createInteractivePrepareStep({
    stablePrefix: options.stablePrefix,
    conversationContext: options.conversationContext,
    dynamicContext: options.dynamicContext,
    thinkingBudget: options.thinkingBudget ?? 8000,
    modelId: options.modelId,
    recordStepModelId: (stepNumber, stepModelId) => {
      stepModelIds[stepNumber - 1] = stepModelId ?? options.modelId;
    },
    channelId: options.channelId,
    threadTs: options.threadTs,
    invocationId: options.invocationId,
    getEscalationModel,
  });

  const system = buildCachedSystemMessages(
    options.stablePrefix,
    options.conversationContext,
    options.dynamicContext,
  );

  return streamText({
    model: options.model,
    system,
    messages: options.messages,
    tools: options.tools,
    prepareStep,
    stopWhen: stepCountIs(options.maxSteps ?? 250),
    onFinish: options.onFinish
      ? (event) =>
          options.onFinish?.({
            ...event,
            stepModelIds: [...stepModelIds],
          })
      : undefined,
  });
}

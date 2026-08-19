import {
  streamText,
  convertToModelMessages,
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  type UIMessage,
  type StepResult,
  type LanguageModelUsage,
} from "ai";
import { createInteractivePrepareStep } from "./prepare-step.js";
import { buildCachedSystemMessages, getEscalationModel } from "../lib/ai.js";
import { getDeferredToolManifest } from "../tools/deferred.js";
import { appendDeferredToolsBlock } from "../personality/system-prompt.js";
import { aiTelemetry, withTrace } from "../lib/langfuse.js";

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
  environmentContext: string;
  conversationContext: string;
  dynamicContext: string;
  messages: ModelMessage[];
  maxSteps?: number;
  thinkingBudget?: number;
  userId?: string;
  /** Human-readable name for the user, rendered in Langfuse's Users view. */
  userName?: string;
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
  // Deferred-tool manifest is environment-level, so it rides in the cached
  // environment layer ahead of the conversation — not the volatile runtime tail.
  const environmentContext = appendDeferredToolsBlock(
    options.environmentContext,
    getDeferredToolManifest(options.tools),
  ) ?? options.environmentContext;
  const prepareStep = createInteractivePrepareStep({
    stablePrefix: options.stablePrefix,
    environmentContext,
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
    environmentContext,
    options.conversationContext,
    options.dynamicContext,
  );

  // Group every AI SDK span for this turn into one Langfuse trace. sessionId
  // links the turns of a conversation in the Sessions view; userId enables
  // per-user analysis; tags make traces filterable. Attributes propagate to the
  // GenAI spans created synchronously when streamText() is invoked below.
  return withTrace(
    {
      traceName: `${options.channelId ?? "agent"}-chat`,
      sessionId: options.threadTs ?? options.channelId ?? undefined,
      userId: options.userId,
      userName: options.userName,
      tags: [
        `channel:${options.channelId ?? "unknown"}`,
        `model:${options.modelId}`,
      ],
      ...(options.userId ? { metadata: { slackUserId: options.userId } } : {}),
    },
    () =>
      streamText({
        model: options.model,
        instructions: system,
        messages: options.messages,
        tools: options.tools,
        prepareStep,
        stopWhen: isStepCount(options.maxSteps ?? 250),
        telemetry: aiTelemetry("agent-chat", {
          modelId: options.modelId,
          channelId: options.channelId ?? "unknown",
          ...(options.invocationId ? { invocationId: options.invocationId } : {}),
        }),
        onEnd: options.onFinish
          ? (event) =>
              options.onFinish?.({
                ...event,
                stepModelIds: [...stepModelIds],
              })
          : undefined,
      }),
  );
}

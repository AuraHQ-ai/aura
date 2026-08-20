import { ToolLoopAgent, isStepCount, type ToolSet, type LanguageModel } from "ai";
import type { WebClient } from "@slack/web-api";
import type { ScheduleContext } from "@aura/db/schema";
import {
  getMainModel,
  getEscalationModel,
  getModelByCategory,
  buildCachedSystemMessages,
  withCacheControl,
  type JobModelCategory,
} from "./ai.js";
import { createSlackTools } from "../tools/slack.js";
import { getDeferredToolManifest } from "../tools/deferred.js";
import { appendDeferredToolsBlock } from "../personality/system-prompt.js";
import {
  createInteractivePrepareStep,
  createHeadlessPrepareStep,
  STEP_LIMIT,
  HEADLESS_STEP_LIMIT,
} from "../pipeline/prepare-step.js";
import { resolveTurnDeadlines } from "../pipeline/turn-deadline.js";
import { aiTelemetry } from "./langfuse.js";

// ── Interactive Agent ────────────────────────────────────────────────────────
// Used by respond.ts for streaming Slack conversations.

export interface InteractiveAgentOptions {
  slackClient: WebClient;
  context?: ScheduleContext;
  stablePrefix: string;
  environmentContext: string;
  conversationContext: string;
  dynamicContext?: string;
  invocationId?: string;
  channelId?: string;
  threadTs?: string;
  /**
   * Returns the assistant text streamed so far in this turn (issue #1336).
   * respond.ts wires this to its accumulator so a hard-deadline continuation
   * carries the truncated message's own "remaining work" promises.
   */
  getAccumulatedText?: () => string;
}

export interface InteractiveAgentResult {
  agent: ToolLoopAgent<never, Awaited<ReturnType<typeof createSlackTools>>>;
  tools: Awaited<ReturnType<typeof createSlackTools>>;
  modelId: string;
  getStepModelIds: () => string[];
}

export async function createInteractiveAgent(
  options: InteractiveAgentOptions,
): Promise<InteractiveAgentResult> {
  const { modelId, model } = await getMainModel();
  const tools = await createSlackTools(options.slackClient, options.context, modelId, options.invocationId);
  const stepModelIds: string[] = [];
  // Deferred-tool manifest is environment-level ("what you can call"), so it
  // rides in the cached environment layer ahead of the conversation — not the
  // volatile runtime tail.
  const environmentContext = appendDeferredToolsBlock(
    options.environmentContext,
    getDeferredToolManifest(tools),
  ) ?? options.environmentContext;
  const systemMessages = buildCachedSystemMessages(
    options.stablePrefix,
    environmentContext,
    options.conversationContext,
    options.dynamicContext,
  );

  const agent = new ToolLoopAgent({
    model,
    tools,
    instructions: systemMessages,
    stopWhen: isStepCount(STEP_LIMIT),
    telemetry: aiTelemetry("slack-chat", {
      modelId,
      ...(options.channelId ? { channelId: options.channelId } : {}),
      ...(options.invocationId ? { invocationId: options.invocationId } : {}),
    }),
    prepareStep: createInteractivePrepareStep({
      stablePrefix: options.stablePrefix,
      environmentContext,
      conversationContext: options.conversationContext,
      dynamicContext: options.dynamicContext,
      modelId,
      defaultEffort: "medium",
      thinkingBudget: 8000,
      getEscalationModel,
      recordStepModelId: (stepNumber, stepModelId) => {
        stepModelIds[stepNumber - 1] = stepModelId ?? modelId;
      },
      invocationId: options.invocationId,
      channelId: options.channelId,
      threadTs: options.threadTs,
      userId: options.context?.userId,
      turnDeadlines: resolveTurnDeadlines("interactive"),
      getAccumulatedText: options.getAccumulatedText,
    }),
  });

  return { agent, tools, modelId, getStepModelIds: () => [...stepModelIds] };
}

// ── Headless Agent ───────────────────────────────────────────────────────────
// Used by execute-job.ts for autonomous job execution (non-streaming).

export interface HeadlessAgentOptions {
  slackClient: WebClient;
  context?: ScheduleContext;
  systemPrompt: string;
  invocationId?: string;
  /** Model catalog category to execute with. Defaults to "medium" (Sonnet-class) for jobs. */
  modelCategory?: JobModelCategory;
  /**
   * Continuation depth of the job being executed (issue #1320): 0 for a
   * regular job, N when resuming a `[CONTINUE:topic:dN]` continuation. Lets a
   * hard-deadline respawn carry depth N + 1 so the chain is capped.
   */
  continuationDepth?: number;
}

export async function createHeadlessAgent(options: HeadlessAgentOptions) {
  const category: JobModelCategory = options.modelCategory ?? "medium";
  const { modelId, model } =
    category === "main"
      ? await getMainModel()
      : await getModelByCategory(category);
  const tools = await createSlackTools(options.slackClient, options.context, modelId, options.invocationId);
  const stepModelIds: string[] = [];
  const systemPrompt = appendDeferredToolsBlock(
    options.systemPrompt,
    getDeferredToolManifest(tools),
  ) ?? options.systemPrompt;

  const agent = new ToolLoopAgent({
    model,
    tools,
    instructions: withCacheControl(systemPrompt),
    stopWhen: isStepCount(HEADLESS_STEP_LIMIT),
    telemetry: aiTelemetry("headless-job", {
      modelId,
      ...(options.invocationId ? { invocationId: options.invocationId } : {}),
    }),
    prepareStep: createHeadlessPrepareStep({
      stablePrefix: systemPrompt,
      modelId,
      defaultEffort: "medium",
      thinkingBudget: 16000,
      getEscalationModel,
      recordStepModelId: (stepNumber, stepModelId) => {
        stepModelIds[stepNumber - 1] = stepModelId ?? modelId;
      },
      // channelId/threadTs let a hard-deadline continuation resume in the
      // job's thread. invocationId is intentionally NOT passed — headless
      // jobs never claim invocation locks, so enabling the staleness check
      // would falsely abort them as superseded.
      channelId: options.context?.channelId,
      threadTs: options.context?.threadTs,
      userId: options.context?.userId,
      turnDeadlines: resolveTurnDeadlines("headless"),
      continuationDepth: options.continuationDepth,
    }),
  });

  return { agent, modelId, getStepModelIds: () => [...stepModelIds] };
}

// ── Subagent ─────────────────────────────────────────────────────────────────
// Used by subagent.ts for isolated context subtask delegation (non-streaming).

export interface SubagentAgentOptions {
  model: LanguageModel;
  tools: ToolSet;
  systemPrompt: string;
  maxSteps?: number;
}

export function createSubAgent(options: SubagentAgentOptions) {
  const systemPrompt = appendDeferredToolsBlock(
    options.systemPrompt,
    getDeferredToolManifest(options.tools),
  ) ?? options.systemPrompt;

  return new ToolLoopAgent({
    model: options.model,
    tools: options.tools,
    instructions: systemPrompt,
    stopWhen: isStepCount(options.maxSteps ?? 50),
    telemetry: aiTelemetry("subagent"),
  });
}

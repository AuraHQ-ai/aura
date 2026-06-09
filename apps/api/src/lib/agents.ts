import { ToolLoopAgent, stepCountIs, type ToolSet, type LanguageModel } from "ai";
import type { WebClient } from "@slack/web-api";
import type { ScheduleContext } from "@aura/db/schema";
import {
  getMainModel,
  getEscalationModel,
  buildCachedSystemMessages,
  withCacheControl,
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
    stopWhen: stepCountIs(STEP_LIMIT),
    experimental_telemetry: aiTelemetry("slack-chat", {
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
}

export async function createHeadlessAgent(options: HeadlessAgentOptions) {
  const { modelId, model } = await getMainModel();
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
    stopWhen: stepCountIs(HEADLESS_STEP_LIMIT),
    experimental_telemetry: aiTelemetry("headless-job", {
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
    stopWhen: stepCountIs(options.maxSteps ?? 50),
    experimental_telemetry: aiTelemetry("subagent"),
  });
}

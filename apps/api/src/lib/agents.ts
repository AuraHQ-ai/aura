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
import {
  createInteractivePrepareStep,
  createHeadlessPrepareStep,
  STEP_LIMIT,
  HEADLESS_STEP_LIMIT,
} from "../pipeline/prepare-step.js";

// ── Interactive Agent ────────────────────────────────────────────────────────
// Used by respond.ts for streaming Slack conversations.

export interface InteractiveAgentOptions {
  slackClient: WebClient;
  context?: ScheduleContext;
  stablePrefix: string;
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
}

export async function createInteractiveAgent(
  options: InteractiveAgentOptions,
): Promise<InteractiveAgentResult> {
  const { modelId, model } = await getMainModel();
  const tools = await createSlackTools(options.slackClient, options.context, modelId);
  const systemMessages = buildCachedSystemMessages(
    options.stablePrefix,
    options.conversationContext,
    options.dynamicContext,
  );

  const agent = new ToolLoopAgent({
    model,
    tools,
    instructions: systemMessages,
    stopWhen: stepCountIs(STEP_LIMIT),
    prepareStep: createInteractivePrepareStep({
      stablePrefix: options.stablePrefix,
      conversationContext: options.conversationContext,
      dynamicContext: options.dynamicContext,
      modelId,
      defaultEffort: "medium",
      thinkingBudget: 8000,
      getEscalationModel,
      invocationId: options.invocationId,
      channelId: options.channelId,
      threadTs: options.threadTs,
    }),
  });

  return { agent, tools, modelId };
}

// ── Headless Agent ───────────────────────────────────────────────────────────
// Used by execute-job.ts for autonomous job execution (non-streaming).

export interface HeadlessAgentOptions {
  slackClient: WebClient;
  context?: { userId?: string; channelId?: string; threadTs?: string };
  systemPrompt: string;
}

export async function createHeadlessAgent(options: HeadlessAgentOptions) {
  const { modelId, model } = await getMainModel();
  const tools = await createSlackTools(options.slackClient, options.context, modelId);

  const agent = new ToolLoopAgent({
    model,
    tools,
    instructions: withCacheControl(options.systemPrompt),
    stopWhen: stepCountIs(HEADLESS_STEP_LIMIT),
    prepareStep: createHeadlessPrepareStep({
      stablePrefix: options.systemPrompt,
      modelId,
      defaultEffort: "medium",
      thinkingBudget: 16000,
      getEscalationModel,
    }),
  });

  return { agent, modelId };
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
  return new ToolLoopAgent({
    model: options.model,
    tools: options.tools,
    instructions: options.systemPrompt,
    stopWhen: stepCountIs(options.maxSteps ?? 50),
  });
}

/**
 * Durable dashboard chat — one workflow run per assistant turn.
 *
 * Architecture (issue #1111):
 * - The HTTP route starts this workflow and immediately returns the run's
 *   readable stream + `x-workflow-run-id`. The server owns the generation;
 *   the browser is just a reader.
 * - Each model call is a durable step (via `DurableAgent`), and each tool
 *   execution is a durable step (`executeDashboardTool`). A SIGKILL mid-turn
 *   resumes from the last completed step instead of losing the turn.
 * - UIMessageChunks are written to the run's default stream, so clients can
 *   detach/reattach at any time (`/api/dashboard/chat/runs/:runId/stream`).
 *
 * IMPORTANT: a client disconnect must never cancel generation. Nothing in
 * this workflow observes the HTTP request; explicit cancellation goes through
 * the out-of-band cancel endpoint (`getRun(runId).cancel()`).
 */
import { getWritable, getWorkflowMetadata } from "workflow";
import { DurableAgent } from "@workflow/ai/agent";
import {
  asSchema,
  convertToModelMessages,
  jsonSchema,
  type JSONSchema7,
  type ModelMessage,
  type SystemModelMessage,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

export interface DashboardChatWorkflowInput {
  messages: UIMessage[];
  userId: string;
  userName?: string;
  threadId: string;
  requestedModelId?: string | null;
}

interface ToolManifestEntry {
  name: string;
  description: string | undefined;
  inputSchema: JSONSchema7;
}

interface PreparedDashboardTurn {
  modelId: string;
  systemMessages: SystemModelMessage[];
  systemPromptText: string;
  modelMessages: ModelMessage[];
  providerOptions: Record<string, any> | undefined;
  toolManifest: ToolManifestEntry[];
  messageText: string;
  messageId: string;
}

const DASHBOARD_MAX_STEPS = 20;

// ── Steps ────────────────────────────────────────────────────────────────────

/**
 * Build everything the agent loop needs, reduced to serializable data:
 * prompt layers, converted model messages, thinking provider options, and a
 * JSON-schema tool manifest (zod schemas can't cross the step boundary).
 */
async function prepareDashboardTurn(
  input: DashboardChatWorkflowInput,
): Promise<PreparedDashboardTurn> {
  "use step";
  const { getMainModelId } = await import("../src/lib/ai.js");
  const { buildCorePrompt } = await import("../src/pipeline/core-prompt.js");
  const { buildCachedSystemMessages } = await import("../src/lib/ai.js");
  const { getProviderThinkingOptions } = await import("../src/pipeline/prepare-step.js");
  const { createCoreTools } = await import("../src/tools/core.js");
  const { sanitizeAssistantPartOrder } = await import("../src/pipeline/dashboard-messages.js");
  const { logger } = await import("../src/lib/logger.js");

  const modelId = input.requestedModelId || (await getMainModelId());
  logger.info("dashboardChatWorkflow: preparing turn", {
    threadId: input.threadId,
    modelId,
  });

  const lastUserMessage = [...input.messages].reverse().find((m) => m.role === "user");
  const messageText =
    lastUserMessage?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("") || "Hello";
  const messageId = lastUserMessage?.id ?? crypto.randomUUID();

  const prompt = await buildCorePrompt({
    channel: "dashboard",
    userId: input.userId,
    conversationId: "dashboard",
    messageText,
    isDirectMessage: true,
    modelIdOverride: modelId,
  });

  // No Anthropic deferred tool discovery on the durable path: the tool-search
  // provider tool and per-tool providerOptions don't survive the manifest
  // round-trip, so all schemas ship eagerly (modelId intentionally omitted).
  const tools = await createCoreTools(
    { userId: input.userId, channelId: "dashboard" },
    undefined,
    undefined,
  );

  const toolManifest: ToolManifestEntry[] = [];
  for (const [name, t] of Object.entries(tools)) {
    const anyTool = t as any;
    if (!anyTool || typeof anyTool.execute !== "function" || !anyTool.inputSchema) continue;
    toolManifest.push({
      name,
      description: anyTool.description,
      inputSchema: (await asSchema(anyTool.inputSchema).jsonSchema) as JSONSchema7,
    });
  }

  const modelMessages = await convertToModelMessages(
    sanitizeAssistantPartOrder(input.messages),
  );

  const systemMessages = buildCachedSystemMessages(
    prompt.stablePrefix,
    prompt.environmentContext,
    prompt.conversationContext,
    prompt.dynamicContext,
  ) as SystemModelMessage[];

  const providerOptionsRaw = await getProviderThinkingOptions(modelId, 8000);
  const providerOptions =
    Object.keys(providerOptionsRaw).length > 0
      ? (providerOptionsRaw as Record<string, any>)
      : undefined;

  return {
    modelId,
    systemMessages,
    systemPromptText: [
      prompt.stablePrefix,
      prompt.environmentContext,
      prompt.conversationContext,
      prompt.dynamicContext,
    ]
      .filter(Boolean)
      .join("\n\n"),
    modelMessages,
    providerOptions,
    toolManifest,
    messageText,
    messageId,
  };
}

/**
 * Execute one tool call as a durable step. Tools are rebuilt from context
 * inside the step (closures can't cross the step boundary). Errors are
 * returned as `{ ok: false, error }` instead of thrown so side-effectful
 * tools are never blindly retried by the step machinery.
 */
async function executeDashboardTool(
  ctx: { userId: string; threadId: string },
  toolName: string,
  toolInput: unknown,
  toolCallId: string,
): Promise<unknown> {
  "use step";
  const { asSchema: toSchema } = await import("ai");
  const { createCoreTools } = await import("../src/tools/core.js");
  const { executionContext } = await import("../src/lib/tool.js");
  const { logger } = await import("../src/lib/logger.js");

  try {
    const tools = await createCoreTools(
      { userId: ctx.userId, channelId: "dashboard" },
      undefined,
      undefined,
    );
    const t = (tools as Record<string, any>)[toolName];
    if (!t || typeof t.execute !== "function") {
      return { ok: false, error: `Tool "${toolName}" not found` };
    }

    // Validate against the original zod schema (the workflow level only has
    // the JSON-schema projection and accepts anything).
    const validation = await toSchema(t.inputSchema).validate?.(toolInput);
    if (validation && !validation.success) {
      return {
        ok: false,
        error: `Invalid input for tool "${toolName}": ${validation.error?.message ?? "validation failed"}`,
      };
    }
    if (validation?.success) toolInput = validation.value;

    const result = await executionContext.run(
      {
        triggeredBy: ctx.userId,
        triggerType: "user_message",
        callingUserId: ctx.userId,
        channelId: "dashboard",
        threadTs: ctx.threadId,
      },
      () => t.execute(toolInput, { toolCallId, messages: [] }),
    );

    // Tools with toModelOutput produce native content parts (images, files)
    // — pass that shape through so the model sees the file, not base64 JSON.
    if (typeof t.toModelOutput === "function") {
      try {
        return await t.toModelOutput(result);
      } catch {
        return result;
      }
    }
    return result;
  } catch (error: any) {
    logger.error("dashboardChatWorkflow: tool execution failed", {
      toolName,
      error: error?.message || String(error),
    });
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * Persist the completed turn and mark the run row as completed. Runs as the
 * final step of the workflow so persistence survives delivery-side crashes.
 */
async function persistDashboardTurn(params: {
  userId: string;
  threadId: string;
  messageId: string;
  modelId: string;
  messageText: string;
  systemPromptText: string;
  assistantText: string;
  steps: any[];
  status: "completed" | "failed";
}): Promise<void> {
  "use step";
  const { persistDashboardConversation } = await import("../src/pipeline/dashboard-persist.js");
  const { markDashboardChatRunFinished } = await import("../src/lib/dashboard-chat-runs.js");
  const { logger } = await import("../src/lib/logger.js");

  const { workflowRunId: runId } = getWorkflowMetadata();

  if (params.status === "completed") {
    const totalUsage = sumStepUsage(params.steps);
    try {
      await persistDashboardConversation({
        userId: params.userId,
        messageId: params.messageId,
        modelId: params.modelId,
        threadId: params.threadId,
        userMessage: params.messageText,
        assistantText: params.assistantText,
        systemPrompt: params.systemPromptText,
        steps: params.steps,
        stepModelIds: params.steps.map(() => params.modelId),
        totalUsage,
      });
    } catch (error) {
      logger.error("dashboardChatWorkflow: persistence failed", {
        error: String(error),
        threadId: params.threadId,
      });
    }
  }

  await markDashboardChatRunFinished(runId, params.status);
}

function sumStepUsage(steps: any[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const step of steps) {
    inputTokens += step?.usage?.inputTokens ?? 0;
    outputTokens += step?.usage?.outputTokens ?? 0;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokenDetails: {},
    outputTokenDetails: {},
  } as import("ai").LanguageModelUsage;
}

function extractAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (typeof msg.content === "string") return msg.content;
    return msg.content
      .filter((part): part is { type: "text"; text: string } => (part as any).type === "text")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

// ── Workflow ─────────────────────────────────────────────────────────────────

export async function dashboardChatWorkflow(input: DashboardChatWorkflowInput) {
  "use workflow";

  const turn = await prepareDashboardTurn(input);

  const toolCtx = { userId: input.userId, threadId: input.threadId };
  const tools = Object.fromEntries(
    turn.toolManifest.map((entry) => [
      entry.name,
      {
        description: entry.description,
        // Accept-all validation at the workflow level — real zod validation
        // happens inside the tool step where the original schema lives.
        inputSchema: jsonSchema(entry.inputSchema, {
          validate: (value: unknown) => ({ success: true as const, value }),
        }),
        execute: (toolInput: unknown, options: { toolCallId: string }) =>
          executeDashboardTool(toolCtx, entry.name, toolInput, options.toolCallId),
      },
    ]),
  );

  const agent = new DurableAgent({
    model: turn.modelId,
    instructions: turn.systemMessages,
    tools,
    ...(turn.providerOptions ? { providerOptions: turn.providerOptions } : {}),
  });

  let result: Awaited<ReturnType<typeof agent.stream>>;
  try {
    result = await agent.stream({
      messages: turn.modelMessages,
      writable: getWritable<UIMessageChunk>(),
      maxSteps: DASHBOARD_MAX_STEPS,
    });
  } catch (error) {
    await persistDashboardTurn({
      userId: input.userId,
      threadId: input.threadId,
      messageId: turn.messageId,
      modelId: turn.modelId,
      messageText: turn.messageText,
      systemPromptText: turn.systemPromptText,
      assistantText: "",
      steps: [],
      status: "failed",
    });
    throw error;
  }

  const assistantText = extractAssistantText(result.messages);

  await persistDashboardTurn({
    userId: input.userId,
    threadId: input.threadId,
    messageId: turn.messageId,
    modelId: turn.modelId,
    messageText: turn.messageText,
    systemPromptText: turn.systemPromptText,
    assistantText,
    steps: result.steps,
    status: "completed",
  });

  return { text: assistantText };
}

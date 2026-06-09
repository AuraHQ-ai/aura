import { createRoute, z } from "@hono/zod-openapi";
import {
  createUIMessageStreamResponse,
  convertToModelMessages,
  type UIMessage,
  type UIMessageChunk,
  type StepResult,
  type LanguageModelUsage,
} from "ai";
import { waitUntil } from "@vercel/functions";
import { eq, and, sql, asc, desc, inArray } from "drizzle-orm";
import {
  conversationTraces,
  conversationMessages,
  conversationParts,
  dashboardChatChunks,
  dashboardChatRuns,
  users,
} from "@aura/db/schema";
import { gateway } from "@ai-sdk/gateway";
import { db } from "../../db/client.js";
import { getMainModel, getMainModelId, withAnthropicFallback, type WrappableModel } from "../../lib/ai.js";
import { buildCorePrompt } from "../../pipeline/core-prompt.js";
import { createAgenticStream } from "../../pipeline/generate.js";
import { flushLangfuse } from "../../lib/langfuse.js";
import { createCoreTools } from "../../tools/core.js";
import { executionContext } from "../../lib/tool.js";
import { extractMemories } from "../../memory/extract.js";
import {
  createConversationTrace,
  persistConversationInputs,
  persistConversationSteps,
  updateConversationTraceUsage,
  buildConversationSteps,
} from "../../cron/persist-conversation.js";
import { storeMessage } from "../../memory/store.js";
import { buildStepUsages } from "../../lib/cost-calculator.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, createDashboardApp } from "./schemas.js";

export const dashboardChatApp = createDashboardApp();

const WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || "default";
const RUN_STREAM_POLL_MS = 750;

type DashboardRunStatus = "generating" | "completed" | "failed" | "cancelled";

function toThreadStatus(status?: string | null): "generating" | "idle" {
  return status === "generating" ? "generating" : "idle";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── List dashboard chat threads ─────────────────────────────────────────────

const listChatThreadsRoute = createRoute({
  method: "get",
  path: "/threads",
  tags: ["Chat"],
  summary: "List dashboard chat threads",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            threads: z.array(z.object({
              threadId: z.string().nullable(),
              preview: z.string().nullable(),
              lastActivityAt: z.string().nullable(),
              messageCount: z.number(),
              status: z.enum(["generating", "idle"]),
              runId: z.string().nullable(),
            })),
          }),
        },
      },
      description: "Success",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardChatApp.openapi(listChatThreadsRoute, async (c) => {
  try {
    const runRows = await db
      .select({
        id: dashboardChatRuns.id,
        threadId: dashboardChatRuns.threadId,
        prompt: dashboardChatRuns.prompt,
        status: dashboardChatRuns.status,
        updatedAt: sql<string>`${dashboardChatRuns.updatedAt}::text`,
      })
      .from(dashboardChatRuns)
      .orderBy(desc(dashboardChatRuns.updatedAt))
      .limit(100);

    const threadRows = await db
      .select({
        threadTs: conversationTraces.threadTs,
        traceCount: sql<number>`count(*)::int`,
        lastActivityAt: sql<string>`max(${conversationTraces.createdAt})::text`,
        firstTraceId: sql<string>`(array_agg(${conversationTraces.id} ORDER BY ${conversationTraces.createdAt} ASC))[1]`,
      })
      .from(conversationTraces)
      .where(
        and(
          sql`${conversationTraces}."source" = 'dashboard'`,
          sql`${conversationTraces.threadTs} IS NOT NULL`,
        ),
      )
      .groupBy(conversationTraces.threadTs)
      .orderBy(sql`max(${conversationTraces.createdAt}) DESC`)
      .limit(50);

    const firstTraceIds = threadRows.map((t) => t.firstTraceId).filter(Boolean);
    let previews: Record<string, string> = {};
    if (firstTraceIds.length > 0) {
      const previewRows = await db
        .select({
          conversationId: conversationMessages.conversationId,
          content: conversationMessages.content,
        })
        .from(conversationMessages)
        .where(
          and(
            inArray(conversationMessages.conversationId, firstTraceIds),
            eq(conversationMessages.role, "user"),
          ),
        )
        .orderBy(conversationMessages.orderIndex);

      for (const row of previewRows) {
        if (!previews[row.conversationId] && row.content) {
          previews[row.conversationId] = row.content;
        }
      }
    }

    const latestRunByThread = new Map<string, typeof runRows[number]>();
    for (const row of runRows) {
      if (!latestRunByThread.has(row.threadId)) {
        latestRunByThread.set(row.threadId, row);
      }
    }

    const threadsById = new Map<string, {
      threadId: string;
      preview: string | null;
      lastActivityAt: string | null;
      messageCount: number;
      status: "generating" | "idle";
      runId: string | null;
    }>();

    for (const row of threadRows) {
      if (!row.threadTs) continue;
      const latestRun = latestRunByThread.get(row.threadTs);
      const runIsNewer =
        latestRun?.updatedAt && row.lastActivityAt
          ? new Date(latestRun.updatedAt).getTime() > new Date(row.lastActivityAt).getTime()
          : Boolean(latestRun?.updatedAt);

      threadsById.set(row.threadTs, {
        threadId: row.threadTs,
        preview: previews[row.firstTraceId] ?? latestRun?.prompt ?? null,
        lastActivityAt: runIsNewer ? latestRun?.updatedAt ?? row.lastActivityAt : row.lastActivityAt,
        messageCount: row.traceCount,
        status: toThreadStatus(latestRun?.status),
        runId: latestRun?.status === "generating" ? latestRun.id : null,
      });
    }

    for (const run of latestRunByThread.values()) {
      if (threadsById.has(run.threadId)) continue;
      threadsById.set(run.threadId, {
        threadId: run.threadId,
        preview: run.prompt,
        lastActivityAt: run.updatedAt,
        messageCount: 1,
        status: toThreadStatus(run.status),
        runId: run.status === "generating" ? run.id : null,
      });
    }

    const threads = [...threadsById.values()]
      .sort((a, b) => {
        const aTime = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
        const bTime = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
        return bTime - aTime;
      })
      .slice(0, 50);

    return c.json({ threads } as any, 200);
  } catch (error) {
    logger.error("Failed to list dashboard threads", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── Load messages for a dashboard chat thread ───────────────────────────────

const getThreadMessagesRoute = createRoute({
  method: "get",
  path: "/threads/{threadId}/messages",
  tags: ["Chat"],
  summary: "Load messages for a dashboard chat thread",
  request: {
    params: z.object({
      threadId: z.string().openapi({ param: { name: "threadId", in: "path" } }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            messages: z.array(z.record(z.string(), z.unknown())),
            activeRunId: z.string().nullable(),
            runStatus: z.enum(["generating", "idle"]),
          }),
        },
      },
      description: "Success",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Bad request",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardChatApp.openapi(getThreadMessagesRoute, async (c) => {
  const threadId = c.req.param("threadId");
  if (!threadId) return c.json({ error: "threadId is required" }, 400);

  try {
    const traces = await db
      .select({ id: conversationTraces.id })
      .from(conversationTraces)
      .where(
        and(
          sql`${conversationTraces}."source" = 'dashboard'`,
          eq(conversationTraces.channelId, "dashboard"),
          eq(conversationTraces.threadTs, threadId),
        ),
      )
      .orderBy(asc(conversationTraces.createdAt));

    const traceIds = traces.map((t) => t.id);

    const allMessages = traceIds.length > 0
      ? await db
        .select()
        .from(conversationMessages)
        .where(inArray(conversationMessages.conversationId, traceIds))
        .orderBy(asc(conversationMessages.orderIndex))
      : [];

    const allMsgIds = allMessages.map((m) => m.id);
    let allParts: (typeof conversationParts.$inferSelect)[] = [];
    if (allMsgIds.length > 0) {
      allParts = await db
        .select()
        .from(conversationParts)
        .where(inArray(conversationParts.messageId, allMsgIds))
        .orderBy(asc(conversationParts.orderIndex));
    }

    const partsByMsg: Record<string, typeof allParts> = {};
    for (const part of allParts) {
      (partsByMsg[part.messageId] ??= []).push(part);
    }

    const uiMessages: UIMessage[] = [];
    let msgIndex = 0;

    for (const trace of traces) {
      const traceMessages = allMessages.filter((m) => m.conversationId === trace.id);

      for (const msg of traceMessages) {
        if (msg.role === "system") continue;

        const parts = partsByMsg[msg.id] ?? [];
        const uiParts = partsToUIParts(parts, msg.content);

        if (uiParts.length === 0) continue;

        const metadata =
          msg.role === "assistant" && (msg.modelId || msg.resolvedModelId)
            ? {
                modelId: msg.modelId ?? undefined,
                resolvedModelId: msg.resolvedModelId ?? undefined,
              }
            : undefined;

        uiMessages.push({
          id: `restored-${msgIndex++}`,
          role: msg.role as "user" | "assistant",
          parts: uiParts,
          ...(metadata ? { metadata } : {}),
        } as UIMessage);
      }
    }

    const [latestRun] = await db
      .select({
        id: dashboardChatRuns.id,
        status: dashboardChatRuns.status,
        messageId: dashboardChatRuns.messageId,
        prompt: dashboardChatRuns.prompt,
      })
      .from(dashboardChatRuns)
      .where(
        and(
          eq(dashboardChatRuns.workspaceId, WORKSPACE_ID),
          eq(dashboardChatRuns.threadId, threadId),
        ),
      )
      .orderBy(desc(dashboardChatRuns.updatedAt))
      .limit(1);

    if (latestRun?.status === "generating") {
      const alreadyHasPendingUser = uiMessages.some((msg) => msg.id === latestRun.messageId);
      if (!alreadyHasPendingUser) {
        uiMessages.push({
          id: latestRun.messageId,
          role: "user",
          parts: [{ type: "text", text: latestRun.prompt }],
        } as UIMessage);
      }
    }

    return c.json({
      messages: uiMessages,
      activeRunId: latestRun?.status === "generating" ? latestRun.id : null,
      runStatus: toThreadStatus(latestRun?.status),
    } as any, 200);
  } catch (error) {
    logger.error("Failed to load thread messages", { error: String(error), threadId });
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * Anthropic rejects assistant messages where tool_use blocks are followed by
 * text in the same message, because the next message must immediately start
 * with tool_result. Reorder parts so text comes before tool-invocations.
 * Also strip reasoning parts from non-final messages (they require signed
 * provider metadata that we don't persist).
 */
function sanitizeAssistantPartOrder(messages: UIMessage[]): UIMessage[] {
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  return messages.map((msg, index) => {
    if (msg.role !== "assistant" || !msg.parts) return msg;
    const isLastAssistantMessage = index === lastAssistantIndex;
    const rawParts = msg.parts as any[];
    const hasToolParts = rawParts.some(
      (part) =>
        part.type === "dynamic-tool" ||
        (typeof part.type === "string" && part.type.startsWith("tool-")),
    );

    if (!hasToolParts) {
      const filteredParts = rawParts.filter((part) => {
        if (part.type === "step-start") return false;
        if (part.type === "reasoning" && !isLastAssistantMessage) return false;
        return true;
      });
      return filteredParts.length === rawParts.length
        ? msg
        : ({ ...msg, parts: filteredParts } as UIMessage);
    }

    const textParts: any[] = [];
    const toolParts: any[] = [];
    const otherParts: any[] = [];

    for (const part of rawParts) {
      if (part.type === "text") textParts.push(part);
      else if (part.type === "dynamic-tool" || (typeof part.type === "string" && part.type.startsWith("tool-")))
        toolParts.push(part);
      else if (part.type === "reasoning") {
        // Preserve reasoning on the final assistant message so the dashboard can render it.
        if (isLastAssistantMessage) otherParts.push(part);
      } else if (part.type === "step-start") {
        // drop: step-start is UI-only
      } else otherParts.push(part);
    }

    return { ...msg, parts: [...otherParts, ...textParts, ...toolParts] } as UIMessage;
  });
}

function partsToUIParts(
  parts: (typeof conversationParts.$inferSelect)[],
  fallbackContent: string | null,
): UIMessage["parts"] {
  if (parts.length === 0 && fallbackContent) {
    return [{ type: "text", text: fallbackContent }];
  }

  const textParts: UIMessage["parts"] = [];
  const toolParts: UIMessage["parts"] = [];

  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.textValue) {
          textParts.push({ type: "text", text: part.textValue });
        }
        break;
      case "reasoning":
        if (part.textValue) {
          textParts.push({ type: "reasoning", text: part.textValue });
        }
        break;
      case "tool-invocation":
        if (part.toolCallId && part.toolName) {
          toolParts.push({
            type: "dynamic-tool",
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            state: "output-available",
            input: part.toolInput ?? {},
            output: part.toolOutput ?? {},
          });
        }
        break;
      // "step-start" parts are intentionally dropped on restore because they are UI-only.
    }
  }

  // Anthropic requires assistant messages with tool_use blocks to end with
  // tool_use (tool_result must come immediately after). Put text BEFORE
  // tool-invocations so the trailing text doesn't break the tool_use →
  // tool_result pairing that convertToModelMessages emits.
  return [...textParts, ...toolParts];
}

// ── Dashboard chat (streaming) ──────────────────────────────────────────────

const postChatRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Chat"],
  summary: "Send a chat message (streaming response)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            messages: z.array(z.any()),
            userId: z.string().optional(),
            userName: z.string().optional(),
            threadId: z.string().nullable().optional(),
            modelId: z.string().nullable().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "text/event-stream": {
          schema: z.any(),
        },
      },
      description: "Streaming response",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Bad request",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

const getRunStreamRoute = createRoute({
  method: "get",
  path: "/runs/{runId}/stream",
  tags: ["Chat"],
  summary: "Resume a dashboard chat run stream",
  request: {
    params: z.object({
      runId: z.string().openapi({ param: { name: "runId", in: "path" } }),
    }),
    query: z.object({
      startIndex: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "text/event-stream": {
          schema: z.any(),
        },
      },
      description: "Streaming response",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Run not found",
    },
  },
});

async function getRunTailIndex(runId: string): Promise<number> {
  const [row] = await db
    .select({
      tailIndex: sql<number>`coalesce(max(${dashboardChatChunks.chunkIndex}), -1)::int`,
    })
    .from(dashboardChatChunks)
    .where(
      and(
        eq(dashboardChatChunks.workspaceId, WORKSPACE_ID),
        eq(dashboardChatChunks.runId, runId),
      ),
    );

  return row?.tailIndex ?? -1;
}

async function resolveStartIndex(runId: string, rawStartIndex: string | undefined): Promise<{
  startIndex: number;
  tailIndex: number;
}> {
  const parsed = rawStartIndex === undefined ? 0 : Number.parseInt(rawStartIndex, 10);
  const tailIndex = await getRunTailIndex(runId);
  if (!Number.isFinite(parsed)) {
    return { startIndex: 0, tailIndex };
  }

  if (parsed < 0) {
    return { startIndex: Math.max(0, tailIndex + 1 + parsed), tailIndex };
  }

  return { startIndex: Math.max(0, parsed), tailIndex };
}

function createRunChunkStream(runId: string, startIndex: number): ReadableStream<UIMessageChunk> {
  let cancelled = false;
  let nextIndex = startIndex;

  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      void (async () => {
        while (!cancelled) {
          const chunks = await db
            .select({
              chunkIndex: dashboardChatChunks.chunkIndex,
              chunk: dashboardChatChunks.chunk,
            })
            .from(dashboardChatChunks)
            .where(
              and(
                eq(dashboardChatChunks.workspaceId, WORKSPACE_ID),
                eq(dashboardChatChunks.runId, runId),
                sql`${dashboardChatChunks.chunkIndex} >= ${nextIndex}`,
              ),
            )
            .orderBy(asc(dashboardChatChunks.chunkIndex))
            .limit(100);

          for (const row of chunks) {
            if (cancelled) break;
            controller.enqueue(row.chunk as UIMessageChunk);
            nextIndex = row.chunkIndex + 1;
          }

          const [run] = await db
            .select({ status: dashboardChatRuns.status })
            .from(dashboardChatRuns)
            .where(
              and(
                eq(dashboardChatRuns.workspaceId, WORKSPACE_ID),
                eq(dashboardChatRuns.id, runId),
              ),
            )
            .limit(1);

          if (!run || (run.status !== "generating" && chunks.length === 0)) {
            controller.close();
            return;
          }

          await delay(RUN_STREAM_POLL_MS);
        }
      })().catch((error) => controller.error(error));
    },
    cancel() {
      cancelled = true;
    },
  });
}

function runStreamResponse(runId: string, startIndex: number, tailIndex: number, headers?: Record<string, string>): Response {
  return createUIMessageStreamResponse({
    stream: createRunChunkStream(runId, startIndex),
    headers: {
      "x-workflow-run-id": runId,
      "x-workflow-stream-tail-index": String(tailIndex),
      ...headers,
    },
  });
}

dashboardChatApp.openapi(getRunStreamRoute, async (c) => {
  const runId = c.req.param("runId");
  const [run] = await db
    .select({ id: dashboardChatRuns.id })
    .from(dashboardChatRuns)
    .where(
      and(
        eq(dashboardChatRuns.workspaceId, WORKSPACE_ID),
        eq(dashboardChatRuns.id, runId),
      ),
    )
    .limit(1);

  if (!run) return c.json({ error: "Run not found" }, 404);

  const { startIndex, tailIndex } = await resolveStartIndex(
    runId,
    c.req.query("startIndex"),
  );
  return runStreamResponse(runId, startIndex, tailIndex);
});

dashboardChatApp.openapi(postChatRoute, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const messages = body.messages as UIMessage[] | undefined;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "'messages' array is required" }, 400);
  }

  const userId = (body.userId as string) || "dashboard-admin";
  const userName = (body.userName as string) || undefined;
  const threadId = (body.threadId as string) || crypto.randomUUID();
  const requestedModelId = (body.modelId as string) || null;

  try {
    const lastUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    const messageText =
      lastUserMessage?.parts
        ?.filter(
          (p): p is { type: "text"; text: string } => p.type === "text",
        )
        .map((p) => p.text)
        .join("") || "Hello";
    const messageId = lastUserMessage?.id ?? crypto.randomUUID();
    const runId = crypto.randomUUID();

    await db.insert(dashboardChatRuns).values({
      id: runId,
      workspaceId: WORKSPACE_ID,
      threadId,
      status: "generating",
      userId,
      userName,
      messageId,
      prompt: messageText,
      modelId: requestedModelId,
    });

    const runPromise = runDashboardChat({
      runId,
      messages,
      userId,
      userName,
      threadId,
      requestedModelId,
      messageText,
      messageId,
    }).catch((error) => {
      logger.error("Dashboard chat run failed", {
        runId,
        threadId,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    });
    waitUntil(runPromise);

    return runStreamResponse(runId, 0, -1, { "x-aura-thread-id": threadId });
  } catch (error) {
    logger.error("Dashboard chat error", {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    });
    return c.json({ error: "Internal server error" }, 500);
  }
});

async function persistRunChunk(runId: string, chunkIndex: number, chunk: UIMessageChunk): Promise<void> {
  await db
    .insert(dashboardChatChunks)
    .values({
      workspaceId: WORKSPACE_ID,
      runId,
      chunkIndex,
      chunk,
    })
    .onConflictDoNothing();

  await db
    .update(dashboardChatRuns)
    .set({ updatedAt: sql`now()` })
    .where(
      and(
        eq(dashboardChatRuns.workspaceId, WORKSPACE_ID),
        eq(dashboardChatRuns.id, runId),
      ),
    );
}

async function updateRunStatus(runId: string, status: DashboardRunStatus, error?: string): Promise<void> {
  await db
    .update(dashboardChatRuns)
    .set({
      status,
      error,
      updatedAt: sql`now()`,
      completedAt: status === "generating" ? null : sql`now()`,
    })
    .where(
      and(
        eq(dashboardChatRuns.workspaceId, WORKSPACE_ID),
        eq(dashboardChatRuns.id, runId),
      ),
    );
}

async function runDashboardChat(params: {
  runId: string;
  messages: UIMessage[];
  userId: string;
  userName?: string;
  threadId: string;
  requestedModelId: string | null;
  messageText: string;
  messageId: string;
}): Promise<void> {
  const {
    runId,
    messages,
    userId,
    userName,
    threadId,
    requestedModelId,
    messageText,
    messageId,
  } = params;

  let chunkIndex = 0;

  try {
    let model: WrappableModel;
    let modelId: string;

    if (requestedModelId) {
      modelId = requestedModelId;
      model = withAnthropicFallback(gateway(modelId), modelId);
      logger.info("Dashboard chat using requested model", { modelId, runId });
    } else {
      const resolved = await getMainModel();
      model = resolved.model;
      modelId = await getMainModelId();
      logger.info("Dashboard chat using default model", { modelId, runId });
    }

    await db
      .update(dashboardChatRuns)
      .set({ modelId, updatedAt: sql`now()` })
      .where(
        and(
          eq(dashboardChatRuns.workspaceId, WORKSPACE_ID),
          eq(dashboardChatRuns.id, runId),
        ),
      );

    const prompt = await buildCorePrompt({
      channel: "dashboard",
      userId,
      conversationId: "dashboard",
      messageText,
      isDirectMessage: true,
      modelIdOverride: modelId,
    });

    const tools = await createCoreTools(
      { userId, channelId: "dashboard" },
      undefined,
      modelId,
    );

    const sanitizedMessages = sanitizeAssistantPartOrder(messages);
    const modelMessages = await convertToModelMessages(sanitizedMessages);
    let persistPromise: Promise<void> | undefined;

    const result = executionContext.run(
      { triggeredBy: userId, triggerType: "user_message", callingUserId: userId, channelId: "dashboard", threadTs: threadId },
      () => createAgenticStream({
        model,
        modelId,
        tools,
        stablePrefix: prompt.stablePrefix,
        environmentContext: prompt.environmentContext,
        conversationContext: prompt.conversationContext,
        dynamicContext: prompt.dynamicContext,
        messages: modelMessages,
        maxSteps: 20,
        channelId: "dashboard",
        threadTs: threadId,
        userId,
        userName,
        onFinish: ({ steps, stepModelIds, totalUsage, text }) => {
          logger.info("Dashboard chat onFinish fired", { threadId, userId, messageId, runId, textLen: text.length });
          const fullSystemPrompt = [prompt.stablePrefix, prompt.environmentContext, prompt.conversationContext, prompt.dynamicContext].filter(Boolean).join("\n\n");
          persistPromise = persistDashboardConversation({
            userId,
            messageId,
            modelId,
            threadId,
            userMessage: messageText,
            assistantText: text,
            systemPrompt: fullSystemPrompt,
            steps,
            stepModelIds,
            totalUsage,
          }).catch((err) => {
            logger.error("persistDashboardConversation rejected", { runId, error: String(err) });
          });
        },
      }),
    );

    const uiStream = result.toUIMessageStream({
      originalMessages: messages,
      sendReasoning: true,
      messageMetadata: ({ part }) => {
        if (part.type === "start") {
          return { modelId };
        }
      },
    });

    for await (const chunk of uiStream) {
      await persistRunChunk(runId, chunkIndex++, chunk as UIMessageChunk);
    }

    if (persistPromise) {
      await persistPromise;
    }

    await flushLangfuse();
    await updateRunStatus(runId, "completed");
  } catch (error) {
    const message = errorMessage(error);
    await persistRunChunk(runId, chunkIndex++, {
      type: "error",
      errorText: message,
    } as UIMessageChunk);
    await updateRunStatus(runId, "failed", message);
    await flushLangfuse();
    throw error;
  }
}

async function persistDashboardConversation(params: {
  userId: string;
  messageId: string;
  modelId: string;
  threadId: string | null;
  userMessage: string;
  assistantText: string;
  systemPrompt: string;
  steps: StepResult<any>[];
  stepModelIds: string[];
  totalUsage: LanguageModelUsage;
}): Promise<void> {
  const { userId, messageId, modelId, threadId, userMessage, assistantText, systemPrompt, steps, stepModelIds, totalUsage } = params;

  try {
    logger.info("persistDashboardConversation started", { threadId, messageId });
    const userExternalId = `dashboard-${userId}-${messageId}`;
    const assistantExternalId = `${userExternalId}-aura`;

    // Best-effort message storage: memory extraction should still run even if one insert fails.
    let userMessageId: string | undefined;
    try {
      userMessageId = await storeMessage({
        externalId: userExternalId,
        channelId: "dashboard",
        channelType: "dashboard",
        slackThreadTs: threadId,
        userId,
        role: "user",
        content: userMessage,
      });
    } catch (error) {
      logger.error("Failed to store dashboard user message (continuing)", {
        error: String(error),
        externalId: userExternalId,
        threadId,
      });
    }

    try {
      await storeMessage({
        externalId: assistantExternalId,
        channelId: "dashboard",
        channelType: "dashboard",
        slackThreadTs: threadId,
        userId: "aura",
        role: "assistant",
        content: assistantText,
        tokenUsage: {
          inputTokens: totalUsage.inputTokens ?? 0,
          outputTokens: totalUsage.outputTokens ?? 0,
          totalTokens: totalUsage.totalTokens ?? 0,
        },
        model: modelId,
      });
    } catch (error) {
      logger.error("Failed to store dashboard assistant message (continuing)", {
        error: String(error),
        externalId: assistantExternalId,
        threadId,
      });
    }

    try {
      await extractMemories({
        userMessage,
        assistantResponse: assistantText,
        userId,
        channelType: "dashboard",
        sourceMessageId: userMessageId,
        channelId: "dashboard",
        threadTs: threadId ?? undefined,
        displayName: await resolveDashboardDisplayName(userId),
      });
    } catch (extractErr: any) {
      logger.warn("Memory extraction failed (non-fatal)", {
        error: extractErr?.message || String(extractErr),
      });
    }

    const traceId = await createConversationTrace({
      sourceType: "interactive",
      source: "dashboard",
      channelId: "dashboard",
      threadTs: threadId ?? undefined,
      userId,
      modelId,
    });

    if (traceId) {
      const orderIndex = await persistConversationInputs(traceId, systemPrompt, userMessage);

      const conversationSteps = buildConversationSteps(steps, stepModelIds, modelId);
      await persistConversationSteps(traceId, conversationSteps, orderIndex);

      const stepUsages = buildStepUsages(steps, stepModelIds, modelId);
      await updateConversationTraceUsage(traceId, {
        inputTokens: totalUsage.inputTokens ?? 0,
        outputTokens: totalUsage.outputTokens ?? 0,
        totalTokens: totalUsage.totalTokens ?? 0,
      }, stepUsages);
    }

    logger.info("Dashboard conversation persisted", { traceId, threadId });
  } catch (error) {
    logger.error("Failed to persist dashboard conversation", {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      threadId,
    });
  }
}

async function resolveDashboardDisplayName(userId: string): Promise<string> {
  try {
    const [row] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.slackUserId, userId))
      .limit(1);
    return row?.displayName || userId;
  } catch {
    return userId;
  }
}

import { createRoute, z } from "@hono/zod-openapi";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  type UIMessage,
  type StepResult,
  type LanguageModelUsage,
} from "ai";
import { waitUntil } from "@vercel/functions";
import { eq, and, sql, asc, desc, inArray } from "drizzle-orm";
import { conversationTraces, conversationMessages, conversationParts, users, chatRuns } from "@aura/db/schema";
import { gateway } from "@ai-sdk/gateway";
import { db } from "../../db/client.js";
import { getMainModel, getMainModelId, withAnthropicFallback, type WrappableModel } from "../../lib/ai.js";
import { buildCorePrompt } from "../../pipeline/core-prompt.js";
import { createAgenticStream } from "../../pipeline/generate.js";
import { dbRunStore } from "../../pipeline/run-store-db.js";
import { consumeAndPersist, createReplayStream } from "../../pipeline/run-store.js";
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

/**
 * Same-instance fast path for explicit "stop": if the run's writer is alive in
 * this serverless instance, abort it immediately. Cross-instance stops are
 * handled durably by the writer polling the run's status in the DB.
 */
const liveRunAborts = new Map<string, AbortController>();

/** Extract the last user-authored text from a persisted UIMessage[] payload. */
function lastUserTextFromInput(inputMessages: unknown): string | null {
  if (!Array.isArray(inputMessages)) return null;
  for (let i = inputMessages.length - 1; i >= 0; i--) {
    const msg = inputMessages[i] as { role?: string; parts?: Array<{ type?: string; text?: string }> };
    if (msg?.role !== "user") continue;
    const text = (msg.parts ?? [])
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    return text || null;
  }
  return null;
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
              status: z.enum(["idle", "generating"]),
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

    // Merge in chat_runs so threads that are mid-generation (or whose run
    // finished but hasn't persisted a trace yet) appear immediately, and so
    // every thread carries a server-anchored generating/idle status (R2).
    const runRows = await db
      .select({
        threadId: chatRuns.threadId,
        status: chatRuns.status,
        inputMessages: chatRuns.inputMessages,
        createdAt: sql<string>`${chatRuns.createdAt}::text`,
      })
      .from(chatRuns)
      .orderBy(desc(chatRuns.createdAt))
      .limit(100);

    type ThreadEntry = {
      threadId: string | null;
      preview: string | null;
      lastActivityAt: string | null;
      messageCount: number;
      status: "idle" | "generating";
    };
    const byThread = new Map<string, ThreadEntry>();

    for (const row of threadRows) {
      if (!row.threadTs) continue;
      byThread.set(row.threadTs, {
        threadId: row.threadTs,
        preview: previews[row.firstTraceId] ?? null,
        lastActivityAt: row.lastActivityAt,
        messageCount: row.traceCount,
        status: "idle",
      });
    }

    const seenRunThreads = new Set<string>();
    for (const run of runRows) {
      const existing = byThread.get(run.threadId);
      if (existing) {
        if (run.status === "running") existing.status = "generating";
        if (run.createdAt && (!existing.lastActivityAt || run.createdAt > existing.lastActivityAt)) {
          existing.lastActivityAt = run.createdAt;
        }
        continue;
      }
      // Thread has runs but no persisted trace yet (e.g. its first turn is
      // still generating). Surface it from the run row.
      if (seenRunThreads.has(run.threadId)) {
        if (run.status === "running") byThread.get(run.threadId)!.status = "generating";
        continue;
      }
      seenRunThreads.add(run.threadId);
      byThread.set(run.threadId, {
        threadId: run.threadId,
        preview: lastUserTextFromInput(run.inputMessages),
        lastActivityAt: run.createdAt,
        messageCount: 0,
        status: run.status === "running" ? "generating" : "idle",
      });
    }

    const threads = [...byThread.values()]
      .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))
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

    if (traces.length === 0) {
      return c.json({ messages: [] } as any, 200);
    }

    const traceIds = traces.map((t) => t.id);

    const allMessages = await db
      .select()
      .from(conversationMessages)
      .where(inArray(conversationMessages.conversationId, traceIds))
      .orderBy(asc(conversationMessages.orderIndex));

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

    return c.json({ messages: uiMessages } as any, 200);
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

  // Declared outside the try so the catch can mark the run errored if setup
  // (prompt build / tool wiring) throws after the run row was created.
  let runId: string | undefined;
  try {
    let model: WrappableModel;
    let modelId: string;

    if (requestedModelId) {
      modelId = requestedModelId;
      model = withAnthropicFallback(gateway(modelId), modelId);
      logger.info("Dashboard chat using requested model", { modelId });
    } else {
      const resolved = await getMainModel();
      model = resolved.model;
      modelId = await getMainModelId();
      logger.info("Dashboard chat using default model", { modelId });
    }

    // Anchor the run server-side as early as possible. The run owns the stream:
    // every UI-message chunk is persisted so a client can detach (tab close,
    // refresh, device hop, new-chat) and re-attach without losing or canceling
    // generation. Creating it before the (slower) prompt/tool setup also lets
    // the thread show a "generating" spinner immediately (R2). This is the WDK
    // resumable-streams contract on our own stack.
    runId = await dbRunStore.createRun({
      threadId,
      userId,
      modelId,
      // Persist the user-visible turn so a fresh session that never saw the
      // request can reconstruct the in-flight user bubble when resuming.
      inputMessages: messages,
    });

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

    const activeRunId = runId;

    // Explicit-stop only. NEVER wire the browser/request abort signal here, or
    // a disconnect would cancel generation and leave nothing to resume.
    const genAbort = new AbortController();
    liveRunAborts.set(activeRunId, genAbort);

    const result = executionContext.run(
      { triggeredBy: userId, triggerType: "user_message", callingUserId: userId, channelId: "dashboard" },
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
        abortSignal: genAbort.signal,
        onFinish: ({ steps, stepModelIds, totalUsage, text }) => {
          logger.info("Dashboard chat onFinish fired", { runId: activeRunId, threadId, userId, messageId, textLen: text.length });
          const fullSystemPrompt = [prompt.stablePrefix, prompt.environmentContext, prompt.conversationContext, prompt.dynamicContext].filter(Boolean).join("\n\n");
          waitUntil(
            persistDashboardConversation({
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
              logger.error("persistDashboardConversation rejected", { error: String(err) });
            }),
          );
          // Drain this turn's Langfuse spans before the function instance freezes.
          waitUntil(flushLangfuse());
        },
      }),
    );

    // The model's UI-message stream is consumed and persisted by a single
    // background writer (kept alive past the HTTP response via waitUntil). The
    // runId is stamped into the `start` chunk metadata so the client can store
    // it for reconnects.
    const uiStream = result.toUIMessageStream({
      originalMessages: messages,
      sendReasoning: true,
      messageMetadata: ({ part }) => {
        if (part.type === "start") return { modelId, runId: activeRunId };
      },
    });

    waitUntil(
      consumeAndPersist(dbRunStore, activeRunId, uiStream, {
        abortController: genAbort,
        onError: (err) =>
          logger.error("Dashboard run writer error", { runId: activeRunId, error: String(err) }),
      }).finally(() => liveRunAborts.delete(activeRunId)),
    );

    // The client (this POST and any later reconnect) is a pure reader of the
    // persisted stream. Its abort signal only detaches the reader.
    return createUIMessageStreamResponse({
      stream: createReplayStream(dbRunStore, activeRunId, {
        startIndex: 0,
        pollMs: 150,
        signal: c.req.raw.signal,
      }),
      headers: { "x-workflow-run-id": activeRunId },
    });
  } catch (error) {
    logger.error("Dashboard chat error", {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    });
    if (runId) {
      liveRunAborts.delete(runId);
      await dbRunStore
        .finishRun(runId, "error", error instanceof Error ? error.message : String(error))
        .catch(() => {});
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── Reconnect to a run's stream (resumable streams) ─────────────────────────

const reconnectStreamRoute = createRoute({
  method: "get",
  path: "/{runId}/stream",
  tags: ["Chat"],
  summary: "Reconnect to a chat run's stream (replay missed chunks + tail live)",
  request: {
    params: z.object({
      runId: z.string().openapi({ param: { name: "runId", in: "path" } }),
    }),
    query: z.object({
      startIndex: z.string().optional().openapi({ param: { name: "startIndex", in: "query" } }),
    }),
  },
  responses: {
    200: {
      content: { "text/event-stream": { schema: z.any() } },
      description: "Streaming response (replayed + live)",
    },
    204: { description: "No active stream for this run" },
  },
});

dashboardChatApp.openapi(reconnectStreamRoute, async (c) => {
  const runId = c.req.param("runId");
  const run = await dbRunStore.getRun(runId);
  if (!run) {
    // No such run: tell the transport there's nothing to resume.
    return new Response(null, { status: 204 });
  }

  const startIndexParam = c.req.query("startIndex");
  let startIndex = startIndexParam ? parseInt(startIndexParam, 10) : 0;
  if (Number.isNaN(startIndex)) startIndex = 0;
  // Resolve negative (from-end) indices against the current tail.
  const tailIndex = await dbRunStore.getTailIndex(runId);
  if (startIndex < 0) startIndex = Math.max(0, tailIndex + startIndex);

  return createUIMessageStreamResponse({
    stream: createReplayStream(dbRunStore, runId, {
      startIndex,
      pollMs: 200,
      signal: c.req.raw.signal,
    }),
    headers: { "x-workflow-stream-tail-index": String(tailIndex) },
  });
});

// ── Explicit stop (the ONLY path that cancels a run server-side) ────────────

const stopRunRoute = createRoute({
  method: "post",
  path: "/{runId}/stop",
  tags: ["Chat"],
  summary: "Cancel a chat run (explicit user stop)",
  request: {
    params: z.object({
      runId: z.string().openapi({ param: { name: "runId", in: "path" } }),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.boolean() }) } }, description: "Canceled" },
  },
});

dashboardChatApp.openapi(stopRunRoute, async (c) => {
  const runId = c.req.param("runId");
  // Durable cancel: flip status so the writer (here or in another instance)
  // observes it and aborts generation.
  await dbRunStore.requestCancel(runId);
  // Same-instance fast path.
  liveRunAborts.get(runId)?.abort();
  return c.json({ ok: true }, 200);
});

// ── Active run for a thread (server-anchored thread↔run mapping, R4) ─────────

const threadRunRoute = createRoute({
  method: "get",
  path: "/threads/{threadId}/run",
  tags: ["Chat"],
  summary: "Get the active (generating) run for a thread, if any",
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
            run: z
              .object({
                runId: z.string(),
                status: z.enum(["running", "done", "error", "canceled"]),
                userText: z.string().nullable(),
              })
              .nullable(),
          }),
        },
      },
      description: "Success",
    },
  },
});

dashboardChatApp.openapi(threadRunRoute, async (c) => {
  const threadId = c.req.param("threadId");
  const run = await dbRunStore.getActiveRunForThread(threadId);
  if (!run) return c.json({ run: null } as any, 200);
  return c.json(
    {
      run: {
        runId: run.id,
        status: run.status,
        userText: lastUserTextFromInput(run.inputMessages),
      },
    } as any,
    200,
  );
});

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

import { createRoute, z } from "@hono/zod-openapi";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { eq, and, sql, asc, inArray } from "drizzle-orm";
import { conversationTraces, conversationMessages, conversationParts, dashboardChatRuns } from "@aura/db/schema";
import { start, getRun } from "workflow/api";
import { db } from "../../db/client.js";
import { getMainModelId } from "../../lib/ai.js";
import {
  recordDashboardChatRun,
  getLatestRunsForThreads,
  getLatestRunForThread,
  getDashboardChatRun,
  markDashboardChatRunFinished,
} from "../../lib/dashboard-chat-runs.js";
import {
  dashboardChatWorkflow,
  type DashboardChatWorkflowInput,
} from "../../../workflows/dashboard-chat.js";
import { appendPendingUserMessage } from "../../pipeline/dashboard-messages.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, createDashboardApp } from "./schemas.js";

export const dashboardChatApp = createDashboardApp();

// ── List dashboard chat threads ─────────────────────────────────────────────

const threadSchema = z.object({
  threadId: z.string().nullable(),
  preview: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  messageCount: z.number(),
  /** "generating" while a workflow run is active for this thread (R2). */
  runStatus: z.enum(["generating", "idle"]),
  /** runId of the in-flight run, if any — used by clients to attach (R3). */
  activeRunId: z.string().nullable(),
});

const listChatThreadsRoute = createRoute({
  method: "get",
  path: "/threads",
  tags: ["Chat"],
  summary: "List dashboard chat threads",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ threads: z.array(threadSchema) }),
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

    // Threads with an active run may not have a persisted trace yet (the
    // trace is written by the workflow's final step) — include them so a
    // fresh browser session sees in-flight conversations (R2, T2).
    const knownThreadIds = new Set(
      threadRows.map((r) => r.threadTs).filter((t): t is string => Boolean(t)),
    );
    const { activeOnlyThreads, runsByThread } = await resolveThreadRuns(knownThreadIds);

    const threads = [
      ...activeOnlyThreads.map((info) => ({
        threadId: info.threadId,
        preview: info.preview,
        lastActivityAt: info.lastActivityAt,
        messageCount: 0,
        runStatus: "generating" as const,
        activeRunId: info.runId,
      })),
      ...threadRows.map((row) => {
        const run = row.threadTs ? runsByThread.get(row.threadTs) : undefined;
        const generating = run?.status === "running";
        return {
          threadId: row.threadTs,
          preview: previews[row.firstTraceId] ?? run?.userMessage ?? null,
          lastActivityAt: row.lastActivityAt,
          messageCount: row.traceCount,
          runStatus: generating ? ("generating" as const) : ("idle" as const),
          activeRunId: generating ? run!.runId : null,
        };
      }),
    ];

    return c.json({ threads } as any, 200);
  } catch (error) {
    logger.error("Failed to list dashboard threads", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

async function resolveThreadRuns(knownThreadIds: Set<string>) {
  // Latest runs for the known threads + any recent running threads that have
  // no persisted trace yet.
  const runningRows = await db
    .select({
      threadId: dashboardChatRuns.threadId,
      userId: dashboardChatRuns.userId,
      createdAt: sql<string>`${dashboardChatRuns.createdAt}::text`,
    })
    .from(dashboardChatRuns)
    .where(eq(dashboardChatRuns.status, "running"))
    .orderBy(sql`${dashboardChatRuns.createdAt} DESC`)
    .limit(50);

  const allThreadIds = new Set<string>(knownThreadIds);
  for (const row of runningRows) allThreadIds.add(row.threadId);

  const runsByThread = await getLatestRunsForThreads([...allThreadIds]);

  const activeOnlyThreads = runningRows
    .filter(
      (row) =>
        !knownThreadIds.has(row.threadId) &&
        runsByThread.get(row.threadId)?.status === "running",
    )
    .map((row) => ({
      threadId: row.threadId,
      runId: runsByThread.get(row.threadId)!.runId,
      // No persisted trace yet — the run's recorded user message is the preview.
      preview: runsByThread.get(row.threadId)!.userMessage,
      lastActivityAt: row.createdAt,
    }));

  return { activeOnlyThreads, runsByThread };
}

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

    // R3: when this thread has an in-flight run, tell the client which run
    // to attach to. The run's stream replays the whole current turn, so the
    // persisted history (completed turns only) never overlaps the live tail.
    const latestRun = await getLatestRunForThread(threadId);
    const activeRun = latestRun?.status === "running" ? latestRun : null;
    const activeRunId = activeRun?.runId ?? null;

    if (traces.length === 0) {
      const messages = activeRun
        ? appendPendingUserMessage([], activeRun.userMessage, activeRun.runId)
        : [];
      return c.json({ messages, activeRunId } as any, 200);
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

    // Sessions attaching mid-generation need the in-flight turn's user bubble
    // (the trace for the current turn is only persisted when it completes).
    const messagesWithPending = activeRun
      ? appendPendingUserMessage(uiMessages, activeRun.userMessage, activeRun.runId)
      : uiMessages;

    return c.json({ messages: messagesWithPending, activeRunId } as any, 200);
  } catch (error) {
    logger.error("Failed to load thread messages", { error: String(error), threadId });
    return c.json({ error: "Internal server error" }, 500);
  }
});

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

// ── Dashboard chat (durable workflow run) ───────────────────────────────────

const postChatRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Chat"],
  summary: "Send a chat message (starts a durable workflow run, streams response)",
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
      description: "Streaming response (x-workflow-run-id header identifies the run)",
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

  try {
    const input: DashboardChatWorkflowInput = {
      messages,
      userId,
      userName,
      threadId,
      requestedModelId,
    };

    // The workflow owns the generation. This request only starts it and
    // attaches a reader — dropping the response (tab close, refresh) never
    // aborts the model call (T5).
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const pendingUserMessage =
      lastUserMessage?.parts
        ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("") || null;

    const run = await start(dashboardChatWorkflow, [input]);

    await recordDashboardChatRun({
      threadId,
      runId: run.runId,
      userId,
      userMessage: pendingUserMessage ?? undefined,
    }).catch(
      (error) => {
        logger.error("Failed to record dashboard chat run", {
          runId: run.runId,
          threadId,
          error: String(error),
        });
      },
    );

    logger.info("Dashboard chat workflow started", {
      runId: run.runId,
      threadId,
      modelId: requestedModelId ?? (await getMainModelId().catch(() => "default")),
    });

    return createUIMessageStreamResponse({
      stream: run.readable as ReadableStream<any>,
      headers: {
        "x-workflow-run-id": run.runId,
        "x-thread-id": threadId,
      },
    });
  } catch (error) {
    logger.error("Dashboard chat error", {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── Stream reconnection (resumable streams) ─────────────────────────────────

const getRunStreamRoute = createRoute({
  method: "get",
  path: "/runs/{runId}/stream",
  tags: ["Chat"],
  summary: "Reattach to an in-flight (or replay a finished) chat run stream",
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
      content: { "text/event-stream": { schema: z.any() } },
      description: "Stream replay from startIndex (default 0)",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown run",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardChatApp.openapi(getRunStreamRoute, async (c) => {
  const runId = c.req.param("runId");
  const startIndexParam = c.req.query("startIndex");
  const startIndex = startIndexParam ? parseInt(startIndexParam, 10) : undefined;

  try {
    // Only allow reattaching to runs we started (defense in depth on top of
    // the dashboard auth middleware).
    const row = await getDashboardChatRun(runId);
    if (!row) return c.json({ error: "Unknown run" }, 404);

    const run = getRun(runId);
    const readable = run.getReadable({
      ...(startIndex !== undefined && Number.isFinite(startIndex) ? { startIndex } : {}),
    });

    // The tail index lets the transport resolve negative startIndex values
    // into absolute positions for retries.
    const tailIndex = await readable.getTailIndex();

    return createUIMessageStreamResponse({
      stream: readable as ReadableStream<any>,
      headers: {
        "x-workflow-run-id": runId,
        "x-workflow-stream-tail-index": String(tailIndex),
      },
    });
  } catch (error) {
    logger.error("Dashboard chat stream reattach failed", {
      runId,
      error: String(error),
    });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── Explicit cancel (the ONLY path that stops generation) ────────────────────

const cancelRunRoute = createRoute({
  method: "post",
  path: "/runs/{runId}/cancel",
  tags: ["Chat"],
  summary: "Cancel an in-flight chat run (explicit user stop)",
  request: {
    params: z.object({
      runId: z.string().openapi({ param: { name: "runId", in: "path" } }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      description: "Cancelled",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown run",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardChatApp.openapi(cancelRunRoute, async (c) => {
  const runId = c.req.param("runId");
  try {
    const row = await getDashboardChatRun(runId);
    if (!row) return c.json({ error: "Unknown run" }, 404);

    await getRun(runId).cancel();
    await markDashboardChatRunFinished(runId, "cancelled");
    return c.json({ ok: true } as any, 200);
  } catch (error) {
    logger.error("Dashboard chat run cancel failed", {
      runId,
      error: String(error),
    });
    return c.json({ error: "Internal server error" }, 500);
  }
});

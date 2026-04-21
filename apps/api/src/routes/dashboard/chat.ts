import { createRoute, z } from "@hono/zod-openapi";
import {
  convertToModelMessages,
  type UIMessage,
  type StepResult,
  type LanguageModelUsage,
} from "ai";
import { waitUntil } from "@vercel/functions";
import { eq, and, sql, asc, inArray } from "drizzle-orm";
import { conversationTraces, conversationMessages, conversationParts, users } from "@aura/db/schema";
import { gateway } from "@ai-sdk/gateway";
import { db } from "../../db/client.js";
import { getMainModel, getMainModelId, withAnthropicFallback, type WrappableModel } from "../../lib/ai.js";
import { buildCorePrompt } from "../../pipeline/core-prompt.js";
import { createAgenticStream } from "../../pipeline/generate.js";
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

    const threads = threadRows.map((row) => ({
      threadId: row.threadTs,
      preview: previews[row.firstTraceId] ?? null,
      lastActivityAt: row.lastActivityAt,
      messageCount: row.traceCount,
    }));

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

    const textParts: any[] = [];
    const toolParts: any[] = [];
    const otherParts: any[] = [];

    for (const part of msg.parts as any[]) {
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

    if (toolParts.length === 0) return msg;
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
          textParts.push({ type: "reasoning", reasoning: part.textValue });
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
  const threadId = (body.threadId as string) || null;
  const requestedModelId = (body.modelId as string) || null;

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

    const tools = await createCoreTools({ userId, channelId: "dashboard" });

    const sanitizedMessages = sanitizeAssistantPartOrder(messages);
    const modelMessages = await convertToModelMessages(sanitizedMessages);

    const result = executionContext.run(
      { triggeredBy: userId, triggerType: "user_message", callingUserId: userId, channelId: "dashboard" },
      () => createAgenticStream({
        model,
        modelId,
        tools,
        stablePrefix: prompt.stablePrefix,
        conversationContext: prompt.conversationContext,
        dynamicContext: prompt.dynamicContext,
        messages: modelMessages,
        maxSteps: 20,
        channelId: "dashboard",
        threadTs: threadId ?? undefined,
        userId,
        onFinish: ({ steps, stepModelIds, totalUsage, text }) => {
          logger.info("Dashboard chat onFinish fired", { threadId, userId, messageId, textLen: text.length });
          const fullSystemPrompt = [prompt.stablePrefix, prompt.conversationContext, prompt.dynamicContext].filter(Boolean).join("\n\n");
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
        },
      }),
    );

    return result.toUIMessageStreamResponse({
      originalMessages: messages,
      sendReasoning: true,
      messageMetadata: ({ part }) => {
        if (part.type === "start") {
          return { modelId };
        }
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

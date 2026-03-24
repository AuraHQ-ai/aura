import { Hono } from "hono";
import {
  convertToModelMessages,
  type UIMessage,
  type StepResult,
  type LanguageModelUsage,
} from "ai";
import { waitUntil } from "@vercel/functions";
import { eq, and, sql, asc } from "drizzle-orm";
import { conversationTraces, conversationMessages, conversationParts } from "@aura/db/schema";
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

export const dashboardChatApp = new Hono();

// ── List dashboard chat threads ─────────────────────────────────────────────

dashboardChatApp.get("/threads", async (c) => {

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
          sql`${conversationMessages.conversationId} IN ${firstTraceIds} AND ${conversationMessages.role} = 'user'`,
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

    return c.json({ threads });
  } catch (error) {
    logger.error("Failed to list dashboard threads", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── Load messages for a dashboard chat thread ───────────────────────────────

dashboardChatApp.get("/threads/:threadId/messages", async (c) => {

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
      return c.json({ messages: [] });
    }

    const traceIds = traces.map((t) => t.id);

    const allMessages = await db
      .select()
      .from(conversationMessages)
      .where(sql`${conversationMessages.conversationId} IN ${traceIds}`)
      .orderBy(asc(conversationMessages.orderIndex));

    const allMsgIds = allMessages.map((m) => m.id);
    let allParts: (typeof conversationParts.$inferSelect)[] = [];
    if (allMsgIds.length > 0) {
      allParts = await db
        .select()
        .from(conversationParts)
        .where(sql`${conversationParts.messageId} IN ${allMsgIds}`)
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

        uiMessages.push({
          id: `restored-${msgIndex++}`,
          role: msg.role as "user" | "assistant",
          parts: uiParts,
        });
      }
    }

    return c.json({ messages: uiMessages });
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

  const uiParts: UIMessage["parts"] = [];

  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.textValue) {
          uiParts.push({ type: "text", text: part.textValue });
        }
        break;
      case "reasoning":
        if (part.textValue) {
          uiParts.push({ type: "reasoning", text: part.textValue, providerMetadata: {} });
        }
        break;
      case "tool-invocation":
        if (part.toolCallId && part.toolName) {
          uiParts.push({
            type: "dynamic-tool",
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            state: "output-available",
            input: part.toolInput ?? {},
            output: part.toolOutput ?? {},
          });
        }
        break;
    }
  }

  return uiParts;
}

// ── Dashboard chat (streaming) ──────────────────────────────────────────────

dashboardChatApp.post("/", async (c) => {
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

    const tools = createCoreTools({ userId, channelId: "dashboard" });

    // Log message parts for debugging tool call conversion issues
    for (const msg of messages) {
      const partTypes = msg.parts?.map((p: any) => p.type) ?? [];
      if (partTypes.some((t: string) => t.startsWith("tool") || t === "dynamic-tool" || t === "step-start")) {
        logger.info("Dashboard chat message with tools", { id: msg.id, role: msg.role, partTypes });
      }
    }

    const modelMessages = await convertToModelMessages(messages);

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
        onFinish: ({ steps, totalUsage, text }) => {
          logger.info("Dashboard chat onFinish fired", { threadId, userId, messageId, textLen: text.length });
          waitUntil(
            persistDashboardConversation({
              userId,
              messageId,
              modelId,
              threadId,
              userMessage: messageText,
              assistantText: text,
              systemPrompt: prompt.stablePrefix,
              steps,
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
    });
  } catch (error) {
    logger.error("Dashboard chat error", { error });
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
  totalUsage: LanguageModelUsage;
}): Promise<void> {
  const { userId, messageId, modelId, threadId, userMessage, assistantText, systemPrompt, steps, totalUsage } = params;

  try {
    logger.info("persistDashboardConversation started", { threadId, messageId });
    const userExternalId = `dashboard-${userId}-${messageId}`;
    const assistantExternalId = `${userExternalId}-aura`;

    await Promise.all([
      storeMessage({
        externalId: userExternalId,
        channelId: "dashboard",
        channelType: "dashboard",
        slackThreadTs: threadId,
        userId,
        role: "user",
        content: userMessage,
      }),
      storeMessage({
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
      }),
    ]);

    await extractMemories({
      userMessage,
      assistantResponse: assistantText,
      userId,
      channelType: "dashboard",
    });

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

      const conversationSteps = buildConversationSteps(steps);
      await persistConversationSteps(traceId, conversationSteps, orderIndex);

      const stepUsages = buildStepUsages(steps);
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

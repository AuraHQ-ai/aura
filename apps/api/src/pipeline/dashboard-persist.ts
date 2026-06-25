import type { StepResult, LanguageModelUsage } from "ai";
import { eq } from "drizzle-orm";
import { users } from "@aura/db/schema";
import { db } from "../db/client.js";
import { extractMemories } from "../memory/extract.js";
import {
  createConversationTrace,
  persistConversationInputs,
  persistConversationSteps,
  updateConversationTraceUsage,
  buildConversationSteps,
} from "../cron/persist-conversation.js";
import { storeMessage } from "../memory/store.js";
import { buildStepUsages } from "../lib/cost-calculator.js";
import { logger } from "../lib/logger.js";

/**
 * Persist one dashboard chat turn: long-term message store, memory
 * extraction, and the conversation trace used to restore threads in the UI.
 *
 * Shared between the legacy in-request SSE path and the durable workflow
 * path (where it runs as a workflow step after the agent loop completes).
 */
export async function persistDashboardConversation(params: {
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

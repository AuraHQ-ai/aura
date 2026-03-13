import { Hono } from "hono";
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
  type StepResult,
  type LanguageModelUsage,
} from "ai";
import { waitUntil } from "@vercel/functions";
import { getMainModel, getMainModelId, buildCachedSystemMessages } from "../lib/ai.js";
import { buildCorePrompt } from "../pipeline/core-prompt.js";
import { createCoreTools } from "../tools/core.js";
import { extractMemories } from "../memory/extract.js";
import {
  createConversationTrace,
  persistConversationInputs,
  persistConversationSteps,
  updateConversationTraceUsage,
  buildConversationSteps,
} from "../cron/persist-conversation.js";
import { buildStepUsages } from "../lib/cost-calculator.js";
import { logger } from "../lib/logger.js";

const MAX_STEPS = 20;

export const dashboardChatApp = new Hono();

dashboardChatApp.post("/", async (c) => {
  const secret = process.env.DASHBOARD_API_SECRET;
  if (!secret) return c.json({ error: "Not configured" }, 503);

  const auth = c.req.header("authorization");
  if (auth !== `Bearer ${secret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

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

  try {
    const { model } = await getMainModel();
    const modelId = await getMainModelId();

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

    const prompt = await buildCorePrompt({
      channel: "dashboard",
      userId,
      conversationId: "dashboard",
      messageText,
      isDirectMessage: true,
    });

    const systemMessages = buildCachedSystemMessages(
      prompt.stablePrefix,
      prompt.conversationContext,
      prompt.dynamicContext,
    );

    const tools = createCoreTools();
    const modelMessages = await convertToModelMessages(messages);

    const result = streamText({
      model,
      system: systemMessages,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      onFinish: ({ steps, totalUsage, text }) => {
        waitUntil(
          persistDashboardConversation({
            userId,
            modelId,
            userMessage: messageText,
            assistantText: text,
            systemPrompt: prompt.stablePrefix,
            steps,
            totalUsage,
          }),
        );
      },
    });

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
  modelId: string;
  userMessage: string;
  assistantText: string;
  systemPrompt: string;
  steps: StepResult<any>[];
  totalUsage: LanguageModelUsage;
}): Promise<void> {
  const { userId, modelId, userMessage, assistantText, systemPrompt, steps, totalUsage } = params;

  try {
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

    logger.info("Dashboard conversation persisted", { traceId });
  } catch (error) {
    logger.error("Failed to persist dashboard conversation", {
      error: String(error),
    });
  }
}

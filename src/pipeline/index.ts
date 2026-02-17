import type { WebClient } from "@slack/web-api";
import {
  buildMessageContext,
  shouldRespond,
  resolveSlackEntities,
  type MessageContext,
} from "./context.js";
import { assemblePrompt } from "./prompt.js";
import { generateResponse } from "./respond.js";
import {
  fetchConversationContext,
  resolveDisplayName,
  type ConversationContext,
} from "./slack-context.js";
import { storeMessage } from "../memory/store.js";
import { extractMemories } from "../memory/extract.js";
import {
  getKnowledgeAboutUser,
  formatKnowledgeSummary,
  forgetMemories,
} from "../memory/transparency.js";
import {
  getOrCreateProfile,
  recordInteraction,
  updateProfileFromConversation,
} from "../users/profiles.js";
import { downloadEventImages, type SlackImage } from "../lib/files.js";
import { pauseSandbox } from "../lib/sandbox.js";
import { logger } from "../lib/logger.js";
import { recordPipelineMetrics, recordError } from "../lib/metrics.js";
import type { KnownEventFromType } from "@slack/bolt";

/** Maximum message length we'll process (characters). Slack max is ~40k. */
const MAX_MESSAGE_LENGTH = 8000;

interface PipelineOptions {
  event: KnownEventFromType<"message"> | KnownEventFromType<"app_mention">;
  client: WebClient;
  botUserId: string;
  /** Slack team ID (from event body) — needed for chatStream in channels */
  teamId?: string;
  /** Vercel waitUntil for background tasks */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * The main message pipeline — the core loop for every incoming message.
 *
 * Steps:
 * 1. Parse context (who, where, what)
 * 2. Decide if we should respond
 * 3. Handle special commands (transparency)
 * 4. Assemble prompt (memories + profile + thread context)
 * 5. Call LLM
 * 6. Post-process and send response
 * 7. Background: store messages, extract memories, update profile
 */
export async function runPipeline(options: PipelineOptions): Promise<void> {
  const { event, client, botUserId, teamId, waitUntil } = options;
  const pipelineStart = Date.now();

  // 1. Parse context
  const context = buildMessageContext(event, botUserId);
  if (!context) {
    logger.debug("Skipped event — no valid context");
    return;
  }

  // 1b. Resolve Slack entity references (<@U...>, <#C...>) to readable names
  context.text = await resolveSlackEntities(client, context.text);

  // 2. Should we respond?
  // Tier 1 checks are deterministic and need no API calls. Only fetch
  // conversation context from the Slack API when Tiers 2–3 need it.
  let conversation: ConversationContext | undefined;
  let decision: { respond: boolean; reason: string };

  if (context.isDm) {
    decision = { respond: true, reason: "dm" };
  } else if (context.isMentioned) {
    decision = { respond: true, reason: "mentioned" };
  } else if (context.isAddressedByName) {
    decision = { respond: true, reason: "addressed_by_name" };
  } else {
    // Tiers 2–3 need live conversation context from the Slack API
    conversation = await fetchConversationContext(
      client,
      context.channelId,
      botUserId,
      context.threadTs,
    );
    decision = await shouldRespond(context, conversation);
  }

  if (!decision.respond) {
    logger.debug("Decided not to respond", {
      reason: decision.reason,
      userId: context.userId,
      channelId: context.channelId,
    });
    // Still store the message for long-term memory, but don't respond
    const storePromise = storeUserMessage(context);
    if (waitUntil) {
      waitUntil(storePromise);
    } else {
      await storePromise;
    }
    return;
  }

  logger.info("Processing message", {
    userId: context.userId,
    channelType: context.channelType,
    isDm: context.isDm,
    respondReason: decision.reason,
    textLength: context.text.length,
    textPreview: context.text.substring(0, 80),
    hasFiles: Array.isArray((event as any).files),
    fileCount: (event as any).files?.length || 0,
    fileTypes: (event as any).files?.map((f: any) => f.mimetype) || [],
    subtype: (event as any).subtype || "none",
  });

  // Determine thread_ts for replies:
  // - In threads: always reply in the thread
  // - In DMs (top-level): omit thread_ts so replies appear inline
  // - In channels (top-level): reply in a thread under the user's message
  const replyThreadTs = context.threadTs
    ? context.threadTs
    : context.isDm
      ? undefined
      : context.messageTs;

  try {
    // ── Edge case: empty or near-empty message (but allow image-only) ───
    const hasFiles = Array.isArray((event as any).files) && (event as any).files.length > 0;
    if (context.text.trim().length === 0 && !hasFiles) {
      // User just @mentioned Aura with no text and no files
      await client.chat.postMessage({
        channel: context.channelId,
        text: "Hey. What's up?",
        thread_ts: replyThreadTs,
      });
      return;
    }

    // ── Edge case: extremely long message ────────────────────────────────
    let messageText = context.text || (hasFiles ? "What do you see in this image?" : "");
    if (messageText.length > MAX_MESSAGE_LENGTH) {
      messageText = messageText.substring(0, MAX_MESSAGE_LENGTH);
      logger.warn("Truncated long message", {
        originalLength: context.text.length,
        truncatedTo: MAX_MESSAGE_LENGTH,
      });
    }

    // Ensure user has a profile
    const displayName = await resolveDisplayName(client, context.userId);
    await getOrCreateProfile(context.userId, displayName);

    // 3. Check for transparency commands first
    const transparencyResult = await handleTransparencyCommands(
      { ...context, text: messageText },
      client,
      replyThreadTs,
    );
    if (transparencyResult) {
      recordPipelineMetrics({
        totalMs: Date.now() - pipelineStart,
        memoriesUsed: 0,
        channelType: context.channelType,
        userId: context.userId,
        isTransparencyCommand: true,
      });
      return;
    }

    // 4. Assemble prompt (memories + profile + live Slack context)
    // Fetch conversation context now if it wasn't needed earlier (Tier 1 path)
    if (!conversation) {
      conversation = await fetchConversationContext(
        client,
        context.channelId,
        botUserId,
        context.threadTs,
      );
    }
    const retrievalStart = Date.now();
    const { systemPrompt, memories } = await assemblePrompt(
      { ...context, text: messageText },
      conversation,
    );
    const retrievalMs = Date.now() - retrievalStart;

    // 4b. Download images if the message has file attachments
    const botToken = process.env.SLACK_BOT_TOKEN || "";
    const images = await downloadEventImages(event, botToken);
    if (images.length > 0) {
      logger.info("Images ready for LLM", {
        count: images.length,
        names: images.map((i) => i.name),
      });
    }

    // 5. Call LLM (streams response directly to Slack via chat.update)
    const llmStart = Date.now();
    const response = await generateResponse({
      systemPrompt,
      userMessage: messageText,
      slackClient: client,
      context: { userId: context.userId, channelId: context.channelId, threadTs: replyThreadTs },
      images,
      channelId: context.channelId,
      threadTs: replyThreadTs,
      teamId,
      recipientUserId: context.userId,
    });
    const llmMs = Date.now() - llmStart;

    // Pause sandbox once after all tool calls are complete for this turn.
    // This avoids the e2b multi-resume bug (e2b-dev/E2B#884) that causes
    // filesystem state loss when pause/resume is called between every tool.
    await pauseSandbox().catch((err: any) => {
      logger.warn("Failed to pause sandbox after response", {
        error: err.message,
      });
    });

    // Response is already posted to Slack via streaming updates

    const totalMs = Date.now() - pipelineStart;

    // Record metrics
    recordPipelineMetrics({
      totalMs,
      llmMs,
      retrievalMs,
      memoriesUsed: memories.length,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      totalTokens: response.usage?.totalTokens,
      channelType: context.channelType,
      userId: context.userId,
      isTransparencyCommand: false,
    });

    logger.info(`Pipeline completed in ${totalMs}ms`, {
      userId: context.userId,
      channelType: context.channelType,
      memoriesUsed: memories.length,
      llmMs,
      retrievalMs,
    });

    // 7. Background tasks (via waitUntil so they don't block the response)
    const backgroundTasks = runBackgroundTasks({
      context: { ...context, text: messageText },
      response: response.raw,
      displayName,
    });

    if (waitUntil) {
      waitUntil(backgroundTasks);
    } else {
      await backgroundTasks;
    }
  } catch (error: any) {
    // Ensure sandbox is paused even on pipeline errors
    await pauseSandbox().catch(() => {});

    const errorMessage = error?.message || String(error);
    const errorName = error?.name || "UnknownError";

    logger.error("Pipeline error", {
      errorName,
      errorMessage,
      userId: context.userId,
      channelId: context.channelId,
      channelType: context.channelType,
    });

    recordError("pipeline", error, {
      userId: context.userId,
      channelId: context.channelId,
      channelType: context.channelType,
    });

    // Try to send a graceful error message
    try {
      await client.chat.postMessage({
        channel: context.channelId,
        text: "Sorry, I hit a snag processing that. Give me a sec and try again.",
        thread_ts: replyThreadTs,
      });
    } catch {
      logger.error("Failed to send error message to Slack");
    }
  }
}

/**
 * Handle transparency commands: "what do you know about me?" and "forget X"
 * Returns true if a command was handled (pipeline should stop), false otherwise.
 */
async function handleTransparencyCommands(
  context: MessageContext,
  client: WebClient,
  replyThreadTs?: string,
): Promise<boolean> {
  const text = context.text.toLowerCase().trim();

  // "What do you know about me?" command
  if (
    text.includes("what do you know about me") ||
    text.includes("what do you remember about me")
  ) {
    try {
      const knowledge = await getKnowledgeAboutUser(context.userId);
      const summary = formatKnowledgeSummary(knowledge);
      await client.chat.postMessage({
        channel: context.channelId,
        text: summary,
        thread_ts: replyThreadTs,
      });
      return true;
    } catch (error) {
      recordError("transparency.knowledge", error, {
        userId: context.userId,
      });
      await client.chat.postMessage({
        channel: context.channelId,
        text: "I hit a snag pulling that together. Try again in a moment.",
        thread_ts: replyThreadTs,
      });
      return true;
    }
  }

  // "Forget X" command
  const forgetMatch = text.match(
    /^(?:please\s+)?forget\s+(?:about\s+)?(?:that\s+)?(.+)/i,
  );
  if (forgetMatch) {
    const whatToForget = forgetMatch[1].trim();
    try {
      const result = await forgetMemories(context.userId, whatToForget);
      if (result.forgottenCount === 0) {
        await client.chat.postMessage({
          channel: context.channelId,
          text: `I looked, but I couldn't find anything matching "${whatToForget}" in what I know about you. Maybe I never stored it, or it might be phrased differently in my memory.`,
          thread_ts: replyThreadTs,
        });
      } else {
        const examplesText =
          result.examples.length > 0
            ? `\n\nRemoved things like:\n${result.examples.map((e) => `- ${e}`).join("\n")}`
            : "";
        await client.chat.postMessage({
          channel: context.channelId,
          text: `Done. I forgot ${result.forgottenCount} thing${result.forgottenCount === 1 ? "" : "s"} related to "${whatToForget}".${examplesText}`,
          thread_ts: replyThreadTs,
        });
      }
      return true;
    } catch (error) {
      recordError("transparency.forget", error, {
        userId: context.userId,
        whatToForget,
      });
      await client.chat.postMessage({
        channel: context.channelId,
        text: "Something went wrong trying to forget that. Try again?",
        thread_ts: replyThreadTs,
      });
      return true;
    }
  }

  return false;
}

/**
 * Store the user's message in the background.
 */
async function storeUserMessage(context: MessageContext): Promise<void> {
  try {
    await storeMessage({
      slackTs: context.messageTs,
      slackThreadTs: context.threadTs,
      channelId: context.channelId,
      channelType: context.channelType,
      userId: context.userId,
      role: "user",
      content: context.text,
    });
  } catch (error) {
    recordError("storeUserMessage", error, { userId: context.userId });
  }
}

/**
 * Run background tasks after responding.
 */
async function runBackgroundTasks(params: {
  context: MessageContext;
  response: string;
  displayName: string;
}): Promise<void> {
  const { context, response, displayName } = params;

  try {
    // Store the user's message
    const userMessageId = await storeMessage({
      slackTs: context.messageTs,
      slackThreadTs: context.threadTs,
      channelId: context.channelId,
      channelType: context.channelType,
      userId: context.userId,
      role: "user",
      content: context.text,
    });

    // Store Aura's response with a pseudo-timestamp
    const assistantTs = `${context.messageTs}-aura`;
    await storeMessage({
      slackTs: assistantTs,
      slackThreadTs: context.threadTs || context.messageTs,
      channelId: context.channelId,
      channelType: context.channelType,
      userId: "aura",
      role: "assistant",
      content: response,
    });

    // Extract memories from this exchange
    await extractMemories({
      userMessage: context.text,
      assistantResponse: response,
      userId: context.userId,
      channelType: context.channelType,
      sourceMessageId: userMessageId || undefined,
      displayName,
    });

    // Record interaction and potentially update profile
    await recordInteraction(context.userId);
    await updateProfileFromConversation(
      context.userId,
      context.text,
      response,
    );
  } catch (error) {
    recordError("backgroundTasks", error, { userId: context.userId });
  }
}


import type { WebClient } from "@slack/web-api";
import {
  buildMessageContext,
  shouldRespond,
  resolveSlackEntities,
  type MessageContext,
} from "./context.js";
import { assemblePrompt } from "./prompt.js";
import { generateResponse } from "./respond.js";
import { safePostMessage } from "../lib/slack-messaging.js";
import {
  fetchConversationContext,
  resolveDisplayName,
  type ConversationContext,
} from "./slack-context.js";
import { storeMessage, claimEvent, storeToolCallMessages, storeChannelReadMessage } from "../memory/store.js";
import type { ToolCallRecord } from "./respond.js";
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
import { downloadEventFiles } from "../lib/files.js";
import { pauseSandbox } from "../lib/sandbox.js";
import { logger } from "../lib/logger.js";
import { logError } from "../lib/error-logger.js";
import { recordPipelineMetrics, recordError } from "../lib/metrics.js";
import type { SlackEvent } from "./context.js";

/** Maximum message length we'll process (characters). Slack max is ~40k. */
const MAX_MESSAGE_LENGTH = 8000;

// ── Tier 0: Fast-reject noise ───────────────────────────────────────────────
// Pure JS, no async, no LLM. Must run before any pipeline processing
// (memory retrieval, embedding, conversation context, etc.)

const FAST_REJECT_SUBTYPES = new Set([
  "bot_message",
  "message_changed",
  "message_deleted",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_archive",
  "channel_unarchive",
  "pinned_item",
  "unpinned_item",
]);

function shouldFastReject(event: SlackEvent, botUserId: string): boolean {
  const ev = event as unknown as Record<string, unknown>;

  if (ev.subtype && FAST_REJECT_SUBTYPES.has(ev.subtype as string)) return true;

  if (ev.bot_id) return true;

  if (ev.user === botUserId) return true;

  return false;
}

/**
 * Build an optional metadata record from a Slack event's rich fields
 * (attachments, blocks, files, forwarded content, etc.).
 * Returns undefined when there's nothing worth storing.
 */
function buildMessageMetadata(
  event: SlackEvent,
): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  const ev = event as unknown as Record<string, unknown>;

  if (Array.isArray(ev.attachments) && ev.attachments.length > 0) {
    meta.attachments = ev.attachments;
  }
  if (Array.isArray(ev.blocks) && ev.blocks.length > 0) {
    meta.blocks = ev.blocks;
  }
  if (Array.isArray(ev.files) && ev.files.length > 0) {
    meta.files = ev.files;
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

interface PipelineOptions {
  event: SlackEvent;
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

  // Tier 0: Fast-reject noise before any processing
  if (shouldFastReject(event, botUserId)) {
    logger.debug("Fast-rejected event", {
      subtype: (event as unknown as Record<string, unknown>).subtype,
      bot_id: (event as unknown as Record<string, unknown>).bot_id,
    });
    return;
  }

  // 1. Parse context
  const context = buildMessageContext(event, botUserId);
  if (!context) {
    logger.debug("Skipped event — no valid context");
    return;
  }

  // 1a. Dedup: atomically claim this event; skip if another handler got there first
  const claimed = await claimEvent(context.messageTs, context.channelId);
  if (!claimed) {
    logger.debug("Skipping duplicate event", {
      ts: context.messageTs,
      channelId: context.channelId,
    });
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
    const storePromise = storeUserMessage(context, event);
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
  // - In channels (top-level): reply in a thread under the user's message
  // - In DMs (top-level): chatStream requires a thread_ts, so we thread
  //   under the user's message. For non-streaming paths (transparency
  //   commands, empty mentions), we still use undefined to reply inline.
  const replyThreadTs = context.threadTs ?? context.messageTs;

  try {
    // ── Edge case: empty or near-empty message (but allow image-only) ───
    const hasFiles = Array.isArray((event as any).files) && (event as any).files.length > 0;
    if (context.text.trim().length === 0 && !hasFiles) {
      await safePostMessage(client, {
        channel: context.channelId,
        text: "Hey. What's up?",
        thread_ts: replyThreadTs,
      });
      return;
    }

    // Set assistant thread status — triggers the shimmer animation on
    // Aura's name and shows a loading indicator while processing.
    // Requires the `assistant:write` scope (enabled via Agents & AI Apps
    // toggle in Slack app settings). Status auto-clears on reply.
    try {
      await client.assistant.threads.setStatus({
        channel_id: context.channelId,
        thread_ts: replyThreadTs,
        status: "Thinking...",
        loading_messages: [
          "Gathering context...",
          "Searching memories...",
          "Pulling it together...",
        ],
      });
    } catch {
      // Non-fatal: scope may not be configured or channel type unsupported
    }

    // ── Edge case: extremely long message ────────────────────────────────
    let messageText = context.text || (hasFiles ? "What can you tell me about this file?" : "");
    if (messageText.length > MAX_MESSAGE_LENGTH) {
      messageText = messageText.substring(0, MAX_MESSAGE_LENGTH);
      logger.warn("Truncated long message", {
        originalLength: context.text.length,
        truncatedTo: MAX_MESSAGE_LENGTH,
      });
    }

    // Ensure user has a profile and resolve their timezone
    const { name: displayName, timezone: slackTimezone } = await resolveDisplayName(client, context.userId);
    const userProfile = await getOrCreateProfile(context.userId, displayName, slackTimezone);
    const userTimezone = userProfile.timezone || "UTC";

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
    const { systemPrompt, dynamicContext, memories, conversations } = await assemblePrompt(
      { ...context, text: messageText },
      conversation,
      client,
    );
    const retrievalMs = Date.now() - retrievalStart;

    // 4b. Download files if the message has attachments
    const botToken = process.env.SLACK_BOT_TOKEN || "";
    const fileParts = await downloadEventFiles(event, botToken);
    if (fileParts.length > 0) {
      logger.info("Files ready for LLM", {
        count: fileParts.length,
        types: fileParts.map((p) => p.type),
      });
    }

    // 5. Call LLM (streams response directly to Slack via chat.update)
    const llmStart = Date.now();
    const response = await generateResponse({
      systemPrompt,
      dynamicContext,
      userMessage: messageText,
      slackClient: client,
      context: { userId: context.userId, channelId: context.channelId, threadTs: replyThreadTs, timezone: userTimezone },
      files: fileParts,
      channelId: context.channelId,
      threadTs: replyThreadTs,
      teamId,
      recipientUserId: context.userId,
      channelType: context.channelType,
    });
    const llmMs = Date.now() - llmStart;

    // Pause sandbox once after all tool calls are complete for this turn.
    // This avoids the e2b multi-resume bug (e2b-dev/E2B#884) that causes
    // filesystem state loss when pause/resume is called between every tool.
    await pauseSandbox().catch((err: any) => {
      logger.warn("Failed to pause sandbox after response", {
        error: err.message,
      });
      logError({
        errorName: "SandboxPauseError",
        errorMessage: err?.message || String(err),
        errorCode: "sandbox_pause_failed",
        userId: context.userId,
        channelId: context.channelId,
        channelType: context.channelType,
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
      conversationsUsed: conversations.length,
      llmMs,
      retrievalMs,
    });

    // 7. Background tasks (via waitUntil so they don't block the response)
    const backgroundTasks = runBackgroundTasks({
      context: { ...context, text: messageText },
      event,
      response: response.raw,
      toolCalls: response.toolCalls,
      displayName,
      client,
      threadMessageCount: conversation.thread?.length ?? 0,
      ...(() => {
        const all = (conversation.thread ?? conversation.recentMessages)
          .map(m => ({ displayName: m.displayName, text: m.text }));
        if (all.length <= 6) return { recentThreadMessages: all, threadMessagesElided: false };
        return { recentThreadMessages: [...all.slice(0, 3), ...all.slice(-3)], threadMessagesElided: true };
      })(),
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
      slackErrorCode: error?.data?.error,
      userId: context.userId,
      channelId: context.channelId,
      channelType: context.channelType,
    });

    recordError("pipeline", error, {
      userId: context.userId,
      channelId: context.channelId,
      channelType: context.channelType,
    });

    logError({
      errorName,
      errorMessage,
      errorCode: error?.data?.error || error?.code || "pipeline_error",
      userId: context.userId,
      channelId: context.channelId,
      channelType: context.channelType,
      stackTrace: error?.stack,
    });

    // Try to send a graceful error message
    try {
      await safePostMessage(client, {
        channel: context.channelId,
        text: "Sorry, I hit a snag processing that. Give me a sec and try again.",
        thread_ts: replyThreadTs,
      });
    } catch (notifyErr: any) {
      logger.error("Failed to send error message to Slack", {
        channelId: context.channelId,
        slackError: notifyErr?.data?.error,
        error: notifyErr?.message || String(notifyErr),
      });
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
      await safePostMessage(client, {
        channel: context.channelId,
        text: summary,
        thread_ts: replyThreadTs,
      });
      return true;
    } catch (error: any) {
      recordError("transparency.knowledge", error, {
        userId: context.userId,
      });
      logError({
        errorName: error?.name || "TransparencyKnowledgeError",
        errorMessage: error?.message || String(error),
        errorCode: "transparency_knowledge",
        userId: context.userId,
        channelId: context.channelId,
        channelType: context.channelType,
        stackTrace: error?.stack,
      });
      await safePostMessage(client, {
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
        await safePostMessage(client, {
          channel: context.channelId,
          text: `I looked, but I couldn't find anything matching "${whatToForget}" in what I know about you. Maybe I never stored it, or it might be phrased differently in my memory.`,
          thread_ts: replyThreadTs,
        });
      } else {
        const examplesText =
          result.examples.length > 0
            ? `\n\nRemoved things like:\n${result.examples.map((e) => `- ${e}`).join("\n")}`
            : "";
        await safePostMessage(client, {
          channel: context.channelId,
          text: `Done. I forgot ${result.forgottenCount} thing${result.forgottenCount === 1 ? "" : "s"} related to "${whatToForget}".${examplesText}`,
          thread_ts: replyThreadTs,
        });
      }
      return true;
    } catch (error: any) {
      recordError("transparency.forget", error, {
        userId: context.userId,
        whatToForget,
      });
      logError({
        errorName: error?.name || "TransparencyForgetError",
        errorMessage: error?.message || String(error),
        errorCode: "transparency_forget",
        userId: context.userId,
        channelId: context.channelId,
        channelType: context.channelType,
        context: { whatToForget },
        stackTrace: error?.stack,
      });
      await safePostMessage(client, {
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
async function storeUserMessage(context: MessageContext, event: SlackEvent): Promise<void> {
  try {
    await storeMessage({
      slackTs: context.messageTs,
      slackThreadTs: context.threadTs,
      channelId: context.channelId,
      channelType: context.channelType,
      userId: context.userId,
      role: "user",
      content: context.text,
      metadata: buildMessageMetadata(event),
    });
  } catch (error: any) {
    recordError("storeUserMessage", error, { userId: context.userId });
    logError({
      errorName: error?.name || "StoreUserMessageError",
      errorMessage: error?.message || String(error),
      errorCode: "store_user_message",
      userId: context.userId,
      channelId: context.channelId,
      channelType: context.channelType,
      stackTrace: error?.stack,
    });
  }
}

/**
 * Run background tasks after responding.
 */
async function runBackgroundTasks(params: {
  context: MessageContext;
  event: SlackEvent;
  response: string;
  toolCalls: ToolCallRecord[];
  displayName: string;
  client: InstanceType<typeof import("@slack/web-api").WebClient>;
  threadMessageCount: number;
  recentThreadMessages: Array<{ displayName: string; text: string }>;
  threadMessagesElided: boolean;
}): Promise<void> {
  const { context, event, response, toolCalls, displayName, client, threadMessageCount, recentThreadMessages, threadMessagesElided } = params;

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
      metadata: buildMessageMetadata(event),
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

    // Store tool call I/O as durable messages
    if (toolCalls.length > 0) {
      const storageCtx = {
        parentTs: context.messageTs,
        threadTs: context.threadTs,
        channelId: context.channelId,
        channelType: context.channelType,
        userId: context.userId,
      };

      await storeToolCallMessages(toolCalls, storageCtx);

      // Store channel reads as dedicated summary messages
      const channelReadTools = ["read_channel_history", "read_dm_history"];
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        if (!channelReadTools.includes(tc.name)) continue;

        const output = tc.rawOutput as any;
        if (output?.ok && Array.isArray(output.messages) && output.messages.length > 0) {
          const channelName = output.channel || output.user || "unknown";
          await storeChannelReadMessage(
            tc.name,
            channelName,
            output.messages,
            { ...storageCtx, toolIndex: i },
          );
        }
      }
    }

    // Extract memories from this exchange (include tool context for richer extraction)
    const toolContextSummary = buildToolContextForExtraction(toolCalls);
    await extractMemories({
      userMessage: context.text,
      assistantResponse: response + toolContextSummary,
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

    // Set or update DM thread title for the Assistant History tab.
    // Runs last so the LLM call doesn't delay critical background work above.
    if (context.isDm) {
      if (!context.threadTs) {
        // Phase 1: Generate initial title after first assistant response
        await setInitialDmThreadTitle({
          userMessage: context.text,
          assistantResponse: response,
          channelId: context.channelId,
          threadTs: context.messageTs,
          client,
        });
      } else {
        // Phase 2: Periodically re-evaluate title in ongoing threads
        await maybeUpdateDmThreadTitle({
          threadMessageCount,
          recentMessages: recentThreadMessages,
          messagesElided: threadMessagesElided,
          assistantResponse: response,
          channelId: context.channelId,
          threadTs: context.threadTs,
          client,
        });
      }
    }
  } catch (error: any) {
    recordError("backgroundTasks", error, { userId: context.userId });
    logError({
      errorName: error?.name || "BackgroundTaskError",
      errorMessage: error?.message || String(error),
      errorCode: "background_tasks",
      userId: context.userId,
      channelId: context.channelId,
      channelType: context.channelType,
      stackTrace: error?.stack,
    });
  }
}

/** Strip wrapping quotes and trailing punctuation that LLMs sometimes add despite instructions. */
function sanitizeTitle(raw: string): string {
  return raw.trim().replace(/^["'""]+|["'""]+$/g, "").replace(/[.!;:]+$/, "").trim();
}

/**
 * Generate and set the initial title for a DM thread.
 * Triggered after the first assistant response so both sides of the
 * conversation are available for a more descriptive title.
 */
async function setInitialDmThreadTitle(params: {
  userMessage: string;
  assistantResponse: string;
  channelId: string;
  threadTs: string;
  client: WebClient;
}): Promise<void> {
  const { userMessage, assistantResponse, channelId, threadTs, client } = params;
  try {
    const { getFastModel } = await import("../lib/ai.js");
    const { generateText } = await import("ai");
    const fastModel = await getFastModel();
    const { text: raw } = await generateText({
      model: fastModel,
      maxOutputTokens: 40,
      prompt: `What is this conversation about? Name the core topic in 3-8 words. No quotes, no punctuation at the end.\n\nUser: "${userMessage.slice(0, 300)}"\n\nAssistant: "${assistantResponse.slice(0, 500)}"`,
    });
    const title = sanitizeTitle(raw).slice(0, 100);
    if (!title) return;
    await client.assistant.threads.setTitle({
      channel_id: channelId,
      thread_ts: threadTs,
      title,
    });
    logger.info("Set initial DM thread title", { title, channelId });
  } catch (error: any) {
    logger.warn("Failed to set DM thread title", {
      error: error?.message || String(error),
      channelId,
    });
  }
}

/**
 * Re-evaluate the DM thread title at message checkpoints (~every 5 messages).
 * Generates a fresh title from recent messages to reflect topic drift.
 * Skips quietly if not at a checkpoint.
 */
async function maybeUpdateDmThreadTitle(params: {
  threadMessageCount: number;
  recentMessages: Array<{ displayName: string; text: string }>;
  messagesElided: boolean;
  assistantResponse: string;
  channelId: string;
  threadTs: string;
  client: WebClient;
}): Promise<void> {
  const { threadMessageCount, recentMessages, messagesElided, assistantResponse, channelId, threadTs, client } = params;

  // +1 for the assistant response we just posted
  const totalMessages = threadMessageCount + 1;

  // Re-evaluate near every 5th message (fuzzy: allows off-by-one from
  // varying user/assistant message counts)
  if (totalMessages < 5 || totalMessages % 5 > 1) return;

  try {
    const { getFastModel } = await import("../lib/ai.js");
    const { generateText } = await import("ai");
    const fastModel = await getFastModel();

    const half = Math.ceil(recentMessages.length / 2);
    const messagesContext = messagesElided
      ? [
          "--- Start of conversation ---",
          ...recentMessages.slice(0, half).map(m => `${m.displayName}: ${m.text.slice(0, 150)}`),
          "--- ... ---",
          ...recentMessages.slice(half).map(m => `${m.displayName}: ${m.text.slice(0, 150)}`),
          "--- Latest ---",
        ].join("\n")
      : recentMessages
          .map(m => `${m.displayName}: ${m.text.slice(0, 150)}`)
          .join("\n");

    const { text: raw } = await generateText({
      model: fastModel,
      maxOutputTokens: 40,
      prompt: `What are the 1-3 core topics discussed in this Slack DM conversation? Express as a short title (5-10 words). If multiple distinct topics, separate them with " / ". Capture the essence of the whole conversation arc, not just the latest messages. No quotes, no punctuation at the end.\n\nConversation:\n${messagesContext}\n\nLatest assistant response: "${assistantResponse.slice(0, 300)}"`,
    });

    const newTitle = sanitizeTitle(raw).slice(0, 100);
    if (newTitle) {
      await client.assistant.threads.setTitle({
        channel_id: channelId,
        thread_ts: threadTs,
        title: newTitle,
      });
      logger.info("Updated DM thread title at checkpoint", {
        newTitle,
        channelId,
        messageCount: totalMessages,
      });
    }
  } catch (error: any) {
    logger.warn("Failed to update DM thread title", {
      error: error?.message || String(error),
      channelId,
      messageCount: threadMessageCount + 1,
    });
  }
}

/**
 * Build a compact summary of tool calls to append to the assistant response
 * before memory extraction, so the LLM can extract facts from tool outputs.
 */
function buildToolContextForExtraction(toolCalls: ToolCallRecord[]): string {
  if (toolCalls.length === 0) return "";

  const informativeTools = toolCalls.filter(
    (tc) =>
      !tc.is_error &&
      !["set_my_status", "add_reaction", "remove_reaction"].includes(tc.name),
  );

  if (informativeTools.length === 0) return "";

  const summaries = informativeTools.slice(0, 10).map((tc) => {
    const outputPreview =
      tc.output.length > 300 ? tc.output.slice(0, 300) + "…" : tc.output;
    return `[Tool: ${tc.name}] ${outputPreview}`;
  });

  return "\n\n---\nTool outputs from this conversation:\n" + summaries.join("\n");
}


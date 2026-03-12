import type { WebClient } from "@slack/web-api";
import {
  buildMessageContext,
  shouldRespond,
  resolveSlackEntities,
  isSlackbotListNotification,
  type MessageContext,
} from "./context.js";
import { assemblePrompt } from "./prompt.js";
import { generateResponse, type LLMResponse } from "./respond.js";
import { InvocationSupersededError } from "./prepare-step.js";
import { safePostMessage } from "../lib/slack-messaging.js";
import {
  fetchConversationContext,
  resolveDisplayName,
  type ConversationContext,
} from "./slack-context.js";
import { storeMessage, claimEvent, storeToolCallMessages, storeChannelReadMessage } from "../memory/store.js";
import { claimInvocation } from "../lib/invocation-lock.js";
import type { ToolCallRecord } from "./respond.js";
import { extractMemories } from "../memory/extract.js";
import {
  getKnowledgeAboutUser,
  formatKnowledgeSummary,
} from "../memory/transparency.js";
import {
  getOrCreateProfile,
  recordInteraction,
  updateProfileFromConversation,
} from "../users/profiles.js";
import { downloadEventFiles } from "../lib/files.js";
import { pauseSandbox } from "../lib/sandbox.js";
import { getSettingJSON } from "../lib/settings.js";
import { logger } from "../lib/logger.js";
import { logError } from "../lib/error-logger.js";
import { recordPipelineMetrics, recordError } from "../lib/metrics.js";
import {
  createConversationTrace,
  persistConversationInputs,
  persistConversationSteps,
  updateConversationTraceUsage,
  type Step as ConversationStep,
} from "../cron/persist-conversation.js";
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
  let alwaysProcessChannels: Set<string> | undefined;

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
    alwaysProcessChannels = new Set(
      (await getSettingJSON<string[]>("always_process_channels", [])) ?? [],
    );
    decision = await shouldRespond(context, conversation, alwaysProcessChannels);
  }

  if (!decision.respond) {
    logger.debug("Decided not to respond", {
      reason: decision.reason,
      userId: context.userId,
      channelId: context.channelId,
    });
    // Still store the message for long-term memory, but don't respond
    await scheduleStoreUserMessage(context, event, waitUntil);
    return;
  }

  // 2b. Claim invocation lock (enables interruption detection).
  // Must run after shouldRespond so non-responding messages don't
  // supersede an in-progress invocation for this thread.
  const effectiveThreadTs = context.threadTs || context.messageTs;
  const invocationId = await claimInvocation(context.channelId, effectiveThreadTs, context.messageTs);

  if (!invocationId) {
    logger.info("Skipping message — a newer message already claimed this thread", {
      channelId: context.channelId,
      threadTs: effectiveThreadTs,
      messageTs: context.messageTs,
    });
    // Still store the message for long-term memory, even though we won't respond
    await scheduleStoreUserMessage(context, event, waitUntil);
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
    const replyThreadTs = context.threadTs || context.messageTs;

  // Capture response & prompt state for persistence in the catch-block
  // interruption path (Path 2) where const-scoped variables aren't accessible.
  let capturedResponse: LLMResponse | undefined;
  let capturedSystemPrompt: string | undefined;
  let capturedUserPrompt: string | undefined;

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

    // ── USLACKBOT list notification enrichment ───────────────────────────
    // Any USLACKBOT message in a tracked List channel is a list activity
    // notification. We attach metadata so the prompt guides the LLM to
    // investigate the actual list item via tools.
    const slackListChannels = new Set(
      (await getSettingJSON<string[]>("slack_list_channels", [])) ?? [],
    );
    if (isSlackbotListNotification(event, slackListChannels)) {
      context.slackListItemContext = {
        messageTs: context.threadTs ?? context.messageTs,
        channelId: context.channelId,
        notificationText: messageText,
      };
      logger.info("Enriched USLACKBOT list notification", {
        channelId: context.channelId,
        messageTs: context.messageTs,
        notificationText: messageText,
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
    const { stablePrefix, conversationContext, dynamicContext, memories, conversations } = await assemblePrompt(
      { ...context, text: messageText },
      conversation,
      client,
    );
    const retrievalMs = Date.now() - retrievalStart;

    capturedSystemPrompt = [stablePrefix, conversationContext, dynamicContext].filter(Boolean).join("\n\n");
    capturedUserPrompt = messageText;

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
      stablePrefix,
      conversationContext,
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
      invocationId,
    });
    const llmMs = Date.now() - llmStart;
    capturedResponse = response;

    if (response.interrupted) {
      logger.info("Pipeline interrupted — invocation superseded", {
        channelId: context.channelId,
      });
      await pauseSandbox().catch(() => {});
      await scheduleStoreUserMessage(context, event, waitUntil);
      await persistInterruptedResponse({
        context,
        response,
        systemPrompt: capturedSystemPrompt,
        userPrompt: capturedUserPrompt,
        replyThreadTs,
      });
      return;
    }

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
    const fullSystemPrompt = [stablePrefix, conversationContext, dynamicContext].filter(Boolean).join("\n\n");
    const backgroundTasks = runBackgroundTasks({
      context: { ...context, text: messageText },
      event,
      response: response.raw,
      toolCalls: response.toolCalls,
      displayName,
      client,
      threadMessageCount: conversation.thread?.length ?? 0,
      tokenUsage: response.usage,
      modelId: response.modelId,
      systemPrompt: fullSystemPrompt,
      userPrompt: messageText,
      stepsPromise: response.stepsPromise,
      replyThreadTs,
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

    if (error instanceof InvocationSupersededError) {
      logger.info("Pipeline interrupted — invocation superseded", {
        invocationId: error.invocationId,
        channelId: context.channelId,
      });
      await scheduleStoreUserMessage(context, event, waitUntil);
      if (capturedResponse) {
        await persistInterruptedResponse({
          context,
          response: capturedResponse,
          systemPrompt: capturedSystemPrompt,
          userPrompt: capturedUserPrompt,
          replyThreadTs,
        });
      }
      return;
    }

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

  return false;
}

/**
 * Store the user's message, scheduling it as a background task via waitUntil
 * when available, otherwise awaiting it inline.
 */
async function scheduleStoreUserMessage(
  context: MessageContext,
  event: SlackEvent,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  const storePromise = storeUserMessage(context, event);
  if (waitUntil) {
    waitUntil(storePromise);
  } else {
    await storePromise;
  }
}

/**
 * Best-effort persistence for interrupted assistant responses.
 * Stores the assistant message, tool calls, and conversation trace
 * so that search_my_conversations and the dashboard have a record.
 * Does NOT run memory extraction or profile updates (too expensive;
 * those will catch up on the next full invocation).
 */
async function persistInterruptedResponse(params: {
  context: MessageContext;
  response: LLMResponse;
  systemPrompt?: string;
  userPrompt?: string;
  replyThreadTs?: string;
}): Promise<void> {
  const { context, response, systemPrompt, userPrompt, replyThreadTs } = params;

  // 1. Store assistant message
  const assistantTs = `${context.messageTs}-aura`;
  await storeMessage({
    slackTs: assistantTs,
    slackThreadTs: context.threadTs || context.messageTs,
    channelId: context.channelId,
    channelType: context.channelType,
    userId: "aura",
    role: "assistant",
    content: response.raw,
    tokenUsage: response.usage,
    model: response.modelId,
  }).catch((err: any) => {
    logger.error("Failed to store interrupted assistant message", { error: err.message });
  });

  // 2. Store tool call I/O if any
  if (response.toolCalls.length > 0) {
    await storeToolCallMessages(response.toolCalls, {
      parentTs: context.messageTs,
      threadTs: context.threadTs,
      channelId: context.channelId,
      channelType: context.channelType,
      userId: context.userId,
    }).catch((err: any) => {
      logger.error("Failed to store interrupted tool call messages", { error: err.message });
    });
  }

  // 3. Persist conversation trace
  if (systemPrompt && userPrompt) {
    try {
      const conversationId = await createConversationTrace({
        sourceType: "interactive",
        channelId: context.channelId,
        threadTs: replyThreadTs || context.threadTs,
        userId: context.userId,
        modelId: response.modelId,
      });

      const orderIndex = await persistConversationInputs(conversationId, systemPrompt, userPrompt);

      if (response.stepsPromise) {
        try {
          const rawSteps = await response.stepsPromise;
          const conversationSteps: ConversationStep[] = rawSteps.map((step: any) => ({
            text: step.text,
            reasoning: Array.isArray(step.reasoning) ? step.reasoning : undefined,
            toolCalls: step.toolCalls?.map((tc: any) => ({
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.input,
            })),
            toolResults: step.toolResults?.map((tr: any) => ({
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
              output: tr.output,
            })),
            finishReason: step.finishReason,
          }));
          await persistConversationSteps(conversationId, conversationSteps, orderIndex);
        } catch (stepsErr: any) {
          logger.error("Failed to persist conversation steps (non-fatal)", {
            conversationId,
            error: stepsErr.message,
          });
        }
      }

      if (response.usage) {
        await updateConversationTraceUsage(conversationId, response.usage);
      }

      logger.info("Interrupted conversation trace persisted", { conversationId });
    } catch (traceErr: any) {
      logger.error("Failed to persist interrupted conversation trace", { error: traceErr.message });
    }
  }
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
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  modelId?: string;
  systemPrompt?: string;
  userPrompt?: string;
  stepsPromise?: PromiseLike<any[]>;
  replyThreadTs?: string;
}): Promise<void> {
  const { context, event, response, toolCalls, displayName, client, threadMessageCount, recentThreadMessages, threadMessagesElided, tokenUsage, modelId, systemPrompt, userPrompt, stepsPromise, replyThreadTs } = params;

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
      tokenUsage,
      model: modelId,
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

    // Persist conversation trace for interactive messages
    if (systemPrompt && userPrompt) {
      try {
        const conversationId = await createConversationTrace({
          sourceType: "interactive",
          channelId: context.channelId,
          threadTs: replyThreadTs || context.threadTs,
          userId: context.userId,
          modelId,
        });

        const orderIndex = await persistConversationInputs(
          conversationId,
          systemPrompt,
          userPrompt,
        );

        if (stepsPromise) {
          try {
            const rawSteps = await stepsPromise;
            const conversationSteps: ConversationStep[] = rawSteps.map((step: any) => ({
              text: step.text,
              reasoning: Array.isArray(step.reasoning) ? step.reasoning : undefined,
              toolCalls: step.toolCalls?.map((tc: any) => ({
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                input: tc.input,
              })),
              toolResults: step.toolResults?.map((tr: any) => ({
                toolCallId: tr.toolCallId,
                toolName: tr.toolName,
                output: tr.output,
              })),
              finishReason: step.finishReason,
            }));
            await persistConversationSteps(conversationId, conversationSteps, orderIndex);
          } catch (stepsErr: any) {
            logger.error("Failed to persist conversation steps (non-fatal)", {
              conversationId,
              error: stepsErr.message,
            });
          }
        }

        if (tokenUsage) {
          await updateConversationTraceUsage(conversationId, tokenUsage);
        }

        logger.info("Interactive conversation trace persisted", { conversationId });
      } catch (traceErr: any) {
        logger.error("Failed to persist interactive conversation trace (non-fatal)", {
          error: traceErr.message,
          channelId: context.channelId,
        });
      }
    }

    // Post optional reasoning trace as a thread reply (gated by env var)
    if (process.env.SHOW_REASONING_IN_SLACK === "true" && stepsPromise && replyThreadTs) {
      try {
        const steps = await stepsPromise;
        const reasoningTexts: string[] = [];
        for (const step of steps) {
          if ((step as any).reasoning) {
            reasoningTexts.push((step as any).reasoning);
          }
        }

        if (reasoningTexts.length > 0) {
          const fullReasoning = reasoningTexts.join("\n\n---\n\n");
          const reasoningTokens = Math.ceil(fullReasoning.length / 4);
          const preview = fullReasoning.slice(0, 500);
          const truncated = fullReasoning.length > 500;
          const quotedPreview = preview
            .split("\n")
            .map((line) => `>${line}`)
            .join("\n");

          const replyText =
            `:brain: _Reasoning trace_ (${reasoningTokens.toLocaleString()} tokens)\n` +
            quotedPreview +
            (truncated ? "\n>_Full trace available in dashboard_" : "");

          await safePostMessage(client, {
            channel: context.channelId,
            text: replyText,
            thread_ts: replyThreadTs,
          });

          logger.info("Posted reasoning trace to Slack", {
            channelId: context.channelId,
            reasoningLength: fullReasoning.length,
            reasoningTokens,
          });
        }
      } catch (reasoningErr: any) {
        logger.warn("Failed to post reasoning trace to Slack (non-fatal)", {
          error: reasoningErr?.message || String(reasoningErr),
        });
      }
    }

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


import type { WebClient } from "@slack/web-api";
import { throttle } from "../tools/rate-limit.js";
import { logger } from "../lib/logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SlackThreadMessage {
  /** Slack user ID */
  user: string;
  /** Resolved display name */
  displayName: string;
  /** Message text */
  text: string;
  /** Slack message timestamp */
  ts: string;
  /** Whether this message is from the bot */
  isBot: boolean;
}

export interface ConversationContext {
  /** The thread the current message is in (if any). Includes parent message. */
  thread: SlackThreadMessage[] | null;
  /** Recent top-level channel/DM messages (for non-threaded context). */
  recentMessages: SlackThreadMessage[];
  /** Whether Aura has replied in the current thread. */
  isAuraParticipant: boolean;
  /** Whether the thread parent message is Aura's. */
  isAuraThread: boolean;
  /** Whether Aura posted recently in the channel (within 1h, for non-threaded context). */
  auraRecentlyActive: boolean;
}

// ── Per-invocation caches ────────────────────────────────────────────────────

const userDisplayNameCache = new Map<string, string>();

export async function resolveDisplayName(
  client: WebClient,
  userId: string,
): Promise<string> {
  const cached = userDisplayNameCache.get(userId);
  if (cached) return cached;

  try {
    const result = await client.users.info({ user: userId });
    const name =
      result.user?.profile?.display_name ||
      result.user?.real_name ||
      result.user?.name ||
      userId;
    userDisplayNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Fetch live conversation context from the Slack API.
 *
 * For threaded messages: calls conversations.replies to get the full thread.
 * For non-threaded messages: calls conversations.history for recent context.
 *
 * Results include participation flags (isAuraParticipant, isAuraThread,
 * auraRecentlyActive) used by shouldRespond and prompt assembly.
 */
export async function fetchConversationContext(
  client: WebClient,
  channelId: string,
  botUserId: string,
  threadTs?: string,
): Promise<ConversationContext> {
  const result: ConversationContext = {
    thread: null,
    recentMessages: [],
    isAuraParticipant: false,
    isAuraThread: false,
    auraRecentlyActive: false,
  };

  try {
    if (threadTs) {
      // ── Threaded message: fetch the full thread ──────────────────────────
      // conversations.replies returns messages oldest-first. We paginate
      // through all pages to ensure we have the complete thread, including
      // the most recent messages needed for context and participation checks.
      const rawMessages: NonNullable<
        Awaited<ReturnType<typeof client.conversations.replies>>["messages"]
      > = [];
      let cursor: string | undefined;
      const MAX_PAGES = 10; // Safety cap: 10 × 200 = 2000 messages max
      let pages = 0;
      do {
        await throttle();
        const repliesResult = await client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: 200,
          cursor,
        });
        rawMessages.push(...(repliesResult.messages || []));
        cursor = repliesResult.response_metadata?.next_cursor || undefined;
        pages++;
      } while (cursor && pages < MAX_PAGES);

      const threadMessages: SlackThreadMessage[] = [];

      for (const msg of rawMessages) {
        const userId = msg.user || msg.bot_id || "unknown";
        const isBot = msg.user === botUserId || (!msg.user && !!msg.bot_id);
        const displayName = isBot
          ? "Aura"
          : await resolveDisplayName(client, userId);

        threadMessages.push({
          user: userId,
          displayName,
          text: msg.text || "",
          ts: msg.ts || "",
          isBot,
        });
      }

      result.thread = threadMessages;

      // Check participation: did Aura reply in this thread?
      result.isAuraParticipant = threadMessages.some(
        (m) => m.isBot && m.ts !== threadTs,
      );

      // Check if the parent message (first in the array) is Aura's
      if (threadMessages.length > 0 && threadMessages[0].isBot) {
        result.isAuraThread = true;
      }
    }

    // ── Always fetch recent channel/DM messages for broader context ──────
    await throttle();
    const historyResult = await client.conversations.history({
      channel: channelId,
      limit: 15,
    });

    const rawHistory = historyResult.messages || [];
    const oneHourAgo = Date.now() / 1000 - 3600;

    for (const msg of rawHistory) {
      const userId = msg.user || msg.bot_id || "unknown";
      const isBot = msg.user === botUserId || (!msg.user && !!msg.bot_id);
      const displayName = isBot
        ? "Aura"
        : await resolveDisplayName(client, userId);

      result.recentMessages.push({
        user: userId,
        displayName,
        text: msg.text || "",
        ts: msg.ts || "",
        isBot,
      });

      // Check if Aura posted in the channel within the last hour
      if (isBot && msg.ts && parseFloat(msg.ts) > oneHourAgo) {
        result.auraRecentlyActive = true;
      }
    }

    // Reverse so oldest messages come first (Slack returns newest first)
    result.recentMessages.reverse();
  } catch (error: any) {
    logger.error("Failed to fetch conversation context from Slack", {
      channelId,
      threadTs,
      error: error.message,
    });
    // Return empty context on failure — pipeline will still work with
    // memories and profile, just without live conversation context.
  }

  return result;
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Format ConversationContext into a string for the system prompt.
 *
 * Thread context takes priority over channel context when both exist.
 * Uses display names for readability.
 *
 * @param includeChannelFallback - When true, falls back to recent channel/DM
 *   messages if no thread is available. Should be true for DMs and threaded
 *   messages, false for non-threaded channel messages (to avoid mislabeling
 *   unrelated channel history as "thread context" in the system prompt).
 */
export function formatConversationContext(
  conversation: ConversationContext,
  includeChannelFallback: boolean = true,
): string | undefined {
  // Prefer thread context if available
  if (conversation.thread && conversation.thread.length > 0) {
    // Cap thread context to avoid inflating the system prompt for long threads.
    // Keep the parent message (first) plus the most recent messages.
    const MAX_THREAD_MESSAGES = 50;
    const thread = conversation.thread;
    const capped =
      thread.length <= MAX_THREAD_MESSAGES
        ? thread
        : [thread[0], ...thread.slice(-MAX_THREAD_MESSAGES + 1)];
    const formatted = capped
      .map((m) => `${m.displayName}: ${m.text}`)
      .join("\n\n");
    return formatted;
  }

  // Fall back to recent channel/DM messages only when appropriate
  if (includeChannelFallback && conversation.recentMessages.length > 0) {
    const formatted = conversation.recentMessages
      .map((m) => `${m.displayName}: ${m.text}`)
      .join("\n\n");
    return formatted;
  }

  return undefined;
}

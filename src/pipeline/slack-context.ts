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
      await throttle();
      const repliesResult = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 20,
      });

      const rawMessages = repliesResult.messages || [];
      const threadMessages: SlackThreadMessage[] = [];

      for (const msg of rawMessages) {
        const userId = msg.user || msg.bot_id || "unknown";
        const isBot = userId === botUserId;
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
      const isBot = userId === botUserId;
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
 */
export function formatConversationContext(
  conversation: ConversationContext,
): string | undefined {
  // Prefer thread context if available
  if (conversation.thread && conversation.thread.length > 0) {
    const formatted = conversation.thread
      .map((m) => `${m.displayName}: ${m.text}`)
      .join("\n\n");
    return formatted;
  }

  // Fall back to recent channel/DM messages
  if (conversation.recentMessages.length > 0) {
    const formatted = conversation.recentMessages
      .map((m) => `${m.displayName}: ${m.text}`)
      .join("\n\n");
    return formatted;
  }

  return undefined;
}

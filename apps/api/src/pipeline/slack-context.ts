import type { WebClient } from "@slack/web-api";

import { logger } from "../lib/logger.js";
import { TOOL_IO_EVENT_TYPE } from "./respond.js";
import { formatTimestamp } from "../lib/temporal.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ToolCallSummary {
  title: string;
  status: string;
  /** Tool input context (e.g., the SQL query, search term, command) */
  details?: string;
  /** Tool result summary (e.g., "42 rows", error message) */
  output?: string;
}

export interface ToolIORecord {
  name: string;
  input: string;
  output: string;
  is_error: boolean;
}

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
  /** Extracted task card data from bot messages (tool call history) */
  toolCalls?: ToolCallSummary[];
  /** Rich tool I/O from Slack message metadata (persisted between turns) */
  toolIO?: ToolIORecord[];
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

const userDisplayNameCache = new Map<string, { name: string; timezone?: string }>();

export async function resolveDisplayName(
  client: WebClient,
  userId: string,
): Promise<{ name: string; timezone?: string }> {
  const cached = userDisplayNameCache.get(userId);
  if (cached) return cached;

  try {
    const result = await client.users.info({ user: userId });
    const name =
      result.user?.profile?.display_name ||
      result.user?.real_name ||
      result.user?.name ||
      userId;
    const timezone = result.user?.tz || undefined;
    const entry = { name, timezone };
    userDisplayNameCache.set(userId, entry);
    return entry;
  } catch {
    return { name: userId };
  }
}

// ── Task Card Extraction ─────────────────────────────────────────────────────

/** Extract plain text from a rich_text object (used in task_card details/output). */
function extractRichText(richText: any): string | undefined {
  if (!richText?.elements) return undefined;
  const parts: string[] = [];
  for (const section of richText.elements) {
    if (!section.elements) continue;
    for (const el of section.elements) {
      if (el.type === "text" && el.text) parts.push(el.text);
    }
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

/** Extract ToolCallSummary entries from task_card blocks on a message. */
function extractToolCalls(blocks: any[] | undefined): ToolCallSummary[] {
  if (!blocks) return [];
  const calls: ToolCallSummary[] = [];
  for (const block of blocks) {
    if (block.type !== "task_card") continue;
    calls.push({
      title: block.title || "Unknown",
      status: block.status || "complete",
      details: extractRichText(block.details),
      output: extractRichText(block.output),
    });
  }
  return calls;
}

// ── Metadata Extraction ──────────────────────────────────────────────────────

/** Extract ToolIORecord entries from Slack message metadata. */
function extractToolIO(msg: any): ToolIORecord[] | undefined {
  const meta = msg.metadata;
  if (!meta || meta.event_type !== TOOL_IO_EVENT_TYPE) return undefined;
  const toolCalls = meta.event_payload?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
  return toolCalls.map((tc: any) => ({
    name: String(tc.name ?? "unknown"),
    input: String(tc.input ?? "{}"),
    output: String(tc.output ?? ""),
    is_error: !!tc.is_error,
  }));
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
        const repliesResult = await client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: 200,
          cursor,
          include_all_metadata: true,
        });
        rawMessages.push(...(repliesResult.messages || []));
        cursor = repliesResult.response_metadata?.next_cursor || undefined;
        pages++;
      } while (cursor && pages < MAX_PAGES);

      const threadMessages: SlackThreadMessage[] = [];

      for (const msg of rawMessages) {
        const userId = msg.user || msg.bot_id || "unknown";
        const isBot = msg.user === botUserId;
        const { name: displayName } = isBot
          ? { name: "Aura" }
          : await resolveDisplayName(client, userId);
        const toolCalls = isBot ? extractToolCalls((msg as any).blocks) : undefined;
        const toolIO = isBot ? extractToolIO(msg) : undefined;

        threadMessages.push({
          user: userId,
          displayName,
          text: msg.text || "",
          ts: msg.ts || "",
          isBot,
          ...(toolCalls?.length && { toolCalls }),
          ...(toolIO?.length && { toolIO }),
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
    const historyResult = await client.conversations.history({
      channel: channelId,
      limit: 15,
      include_all_metadata: true,
    });

    const rawHistory = historyResult.messages || [];
    const oneHourAgo = Date.now() / 1000 - 3600;

    for (const msg of rawHistory) {
      const userId = msg.user || msg.bot_id || "unknown";
      const isBot = msg.user === botUserId;
      const { name: displayName } = isBot
        ? { name: "Aura" }
        : await resolveDisplayName(client, userId);
      const toolCalls = isBot ? extractToolCalls((msg as any).blocks) : undefined;
      const toolIO = isBot ? extractToolIO(msg) : undefined;

      result.recentMessages.push({
        user: userId,
        displayName,
        text: msg.text || "",
        ts: msg.ts || "",
        isBot,
        ...(toolCalls?.length && { toolCalls }),
        ...(toolIO?.length && { toolIO }),
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

/** Format rich tool I/O records into a structured block for context. */
function formatToolIO(records: ToolIORecord[], isOld = false): string {
  const trunc = (s: string, max: number) =>
    s.length > max ? s.slice(0, max) + "..." : s;

  const parts = records.map((r) => {
    const error = r.is_error ? " [ERROR]" : "";
    const inputStr = isOld ? trunc(String(r.input ?? ""), 500) : String(r.input ?? "");
    const outputStr = isOld ? trunc(String(r.output ?? ""), 500) : String(r.output ?? "");
    return `  - ${r.name}${error}\n    Input: ${inputStr}\n    Output: ${outputStr}`;
  });
  return `\n[Tool I/O]\n${parts.join("\n")}`;
}

/** Format tool calls into a compact one-line summary appended to a message. */
function formatToolCalls(toolCalls: ToolCallSummary[]): string {
  const meaningful = toolCalls.filter((tc) => tc.details || tc.output);
  if (meaningful.length === 0) return "";
  const parts = meaningful.map((tc) => {
    const label = tc.title.replace(/\.\.\.$/,"");
    const detail = tc.details ? `(${tc.details})` : "";
    const result = tc.output ? ` -> ${tc.output}` : "";
    const error = tc.status === "error" ? " [ERROR]" : "";
    return `${label}${detail}${result}${error}`;
  });
  return `\n[Tools: ${parts.join(" | ")}]`;
}

/** Format a single message, preferring rich tool I/O over task_card summaries. */
function formatMessage(m: SlackThreadMessage, timezone?: string, isOld = false): string {
  const time = formatTimestamp(m.ts, timezone);
  const base = `[${time}] ${m.displayName}: ${m.text}`;
  if (m.toolIO?.length) return base + formatToolIO(m.toolIO, isOld);
  if (m.toolCalls?.length) return base + formatToolCalls(m.toolCalls);
  return base;
}

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
export async function formatConversationContext(
  conversation: ConversationContext,
  includeChannelFallback: boolean = true,
  timezone?: string,
): Promise<string | undefined> {
  const RECENT_TOOL_IO_COUNT = 10;

  // Prefer thread context if available
  if (conversation.thread && conversation.thread.length > 0) {
    const MAX_THREAD_MESSAGES = 50;
    const thread = conversation.thread;

    let threadFormatted: string;

    if (thread.length <= MAX_THREAD_MESSAGES) {
      threadFormatted = thread
        .map((m, i) => {
          const isOld = i < thread.length - RECENT_TOOL_IO_COUNT;
          return formatMessage(m, timezone, isOld);
        })
        .join("\n\n");
    } else {
      const droppedMessages = thread.slice(1, thread.length - (MAX_THREAD_MESSAGES - 2));
      const recentMessages = thread.slice(-(MAX_THREAD_MESSAGES - 2));

      let summaryEntry: string;
      try {
        const { getFastModel } = await import("../lib/ai.js");
        const { generateText } = await import("ai");
        const fastModel = await getFastModel();

        const droppedText = droppedMessages
          .map((m) => `${m.displayName}: ${m.text.slice(0, 200)}`)
          .join("\n");

        const { text: summary } = await generateText({
          model: fastModel,
          prompt: `These are messages from an ongoing conversation (${droppedMessages.length} messages). Summarize the key decisions, facts, tasks completed/merged, and open threads in 3-5 sentences. Focus on: what was decided, what was built or merged, what tasks were assigned, what is still pending.\n\nMessages:\n${droppedText.slice(0, 8000)}`,
          maxOutputTokens: 200,
        });

        summaryEntry = `[Context: ${droppedMessages.length} earlier messages summarized: ${summary.trim()}]`;
      } catch {
        summaryEntry = `[${droppedMessages.length} earlier messages not shown]`;
      }

      const parts: string[] = [];
      parts.push(formatMessage(thread[0], timezone, true));
      parts.push(summaryEntry);
      recentMessages.forEach((m, i) => {
        const isOld = i < recentMessages.length - RECENT_TOOL_IO_COUNT;
        parts.push(formatMessage(m, timezone, isOld));
      });
      threadFormatted = parts.join("\n\n");
    }

    // Include channel messages posted before the thread root for broader context.
    // recentMessages are in chronological order (oldest-first after the reverse
    // in fetchConversationContext), so we take the last N that precede the root.
    const MAX_SURROUNDING = 5;
    const threadRootTs = parseFloat(thread[0].ts);
    const surrounding = conversation.recentMessages
      .filter((m) => {
        const ts = parseFloat(m.ts);
        return ts < threadRootTs && m.ts !== thread[0].ts;
      })
      .slice(-MAX_SURROUNDING);

    if (surrounding.length > 0) {
      const channelFormatted = surrounding
        .map((m) => formatMessage(m, timezone, true))
        .join("\n\n");
      return (
        "Channel messages near the thread (for context):\n\n" +
        channelFormatted +
        "\n\nRecent thread context:\n\n" +
        threadFormatted
      );
    }

    return threadFormatted;
  }

  // Fall back to recent channel/DM messages only when appropriate
  if (includeChannelFallback && conversation.recentMessages.length > 0) {
    const msgs = conversation.recentMessages;
    const formatted = msgs
      .map((m, i) => {
        const isOld = i < msgs.length - RECENT_TOOL_IO_COUNT;
        return formatMessage(m, timezone, isOld);
      })
      .join("\n\n");
    return formatted;
  }

  return undefined;
}

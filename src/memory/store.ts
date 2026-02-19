import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { messages, memories, eventLocks, type NewMessage, type NewMemory } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import type { ToolCallRecord } from "../pipeline/respond.js";

/**
 * Atomically claim an event for processing using the event_locks table.
 * Returns true if this caller claimed the event, false if it was already claimed.
 * Safe against race conditions — uses INSERT ... ON CONFLICT DO NOTHING RETURNING id.
 */
export async function claimEvent(eventTs: string, channelId: string): Promise<boolean> {
  const result = await db
    .insert(eventLocks)
    .values({ eventTs, channelId })
    .onConflictDoNothing()
    .returning({ id: eventLocks.id });
  return result.length > 0;
}

/**
 * Store a raw message (user or assistant) to the messages table.
 */
export async function storeMessage(message: NewMessage): Promise<string> {
  try {
    const [inserted] = await db
      .insert(messages)
      .values(message)
      .onConflictDoNothing({ target: messages.slackTs })
      .returning({ id: messages.id });

    if (inserted) {
      logger.debug("Stored message", { id: inserted.id, role: message.role });
      return inserted.id;
    }

    // Message already exists (duplicate slack_ts)
    const existing = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.slackTs, message.slackTs))
      .limit(1);

    return existing[0]?.id ?? "";
  } catch (error) {
    logger.error("Failed to store message", {
      error: String(error),
      slackTs: message.slackTs,
    });
    throw error;
  }
}

/**
 * Batch store multiple memories.
 */
export async function storeMemories(newMemories: NewMemory[]): Promise<string[]> {
  if (newMemories.length === 0) return [];

  try {
    const inserted = await db
      .insert(memories)
      .values(newMemories)
      .returning({ id: memories.id });

    logger.info(`Stored ${inserted.length} memories`);
    return inserted.map((r) => r.id);
  } catch (error) {
    logger.error("Failed to batch store memories", { error: String(error) });
    throw error;
  }
}

// ── Invocation Context Storage ──────────────────────────────────────────────

const MAX_TOOL_CONTENT_LENGTH = 2000;

function truncateStr(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Build a human-readable summary of a tool call for the message content field.
 */
function summarizeToolCall(record: ToolCallRecord): string {
  const inputPreview = truncateStr(record.input, 500);
  const outputPreview = truncateStr(record.output, 1200);
  const status = record.is_error ? "ERROR" : "OK";
  return truncateStr(
    `[${record.name}] (${status})\nInput: ${inputPreview}\nOutput: ${outputPreview}`,
    MAX_TOOL_CONTENT_LENGTH,
  );
}

interface ToolCallStorageContext {
  parentTs: string;
  threadTs?: string;
  channelId: string;
  channelType: "dm" | "public_channel" | "private_channel";
  userId: string;
}

/**
 * Store tool call I/O as messages with role 'tool'.
 * Each tool call gets its own message record with a unique pseudo-timestamp.
 */
export async function storeToolCallMessages(
  toolCalls: ToolCallRecord[],
  ctx: ToolCallStorageContext,
): Promise<void> {
  if (toolCalls.length === 0) return;

  const messagesToStore: NewMessage[] = toolCalls.map((tc, i) => ({
    slackTs: `${ctx.parentTs}-tool-${i}`,
    slackThreadTs: ctx.threadTs || ctx.parentTs,
    channelId: ctx.channelId,
    channelType: ctx.channelType,
    userId: ctx.userId,
    role: "tool" as const,
    content: summarizeToolCall(tc),
    metadata: {
      source: "tool_call",
      tool_name: tc.name,
      tool_input: truncateStr(tc.input, 2000),
      tool_output_preview: truncateStr(tc.output, 2000),
      is_error: tc.is_error,
    },
  }));

  let storedCount = 0;
  for (const msg of messagesToStore) {
    try {
      const result = await db
        .insert(messages)
        .values(msg)
        .onConflictDoNothing({ target: messages.slackTs })
        .returning({ id: messages.id });
      if (result.length > 0) storedCount++;
    } catch (error) {
      logger.warn("Failed to store tool call message", {
        error: String(error),
        slackTs: msg.slackTs,
        toolName: (msg.metadata as any)?.tool_name,
      });
    }
  }

  if (storedCount > 0) {
    logger.info(`Stored ${storedCount}/${toolCalls.length} tool call messages`, {
      parentTs: ctx.parentTs,
    });
  }
}

/**
 * Store a channel/DM read as a single summary message with role 'tool'.
 * Captures the fact that messages were read from a channel, with a content
 * summary suitable for embedding and later recall.
 */
export async function storeChannelReadMessage(
  toolName: string,
  channelName: string,
  readMessages: Array<{ user: string; text: string; timestamp?: string }>,
  ctx: ToolCallStorageContext & { toolIndex: number },
): Promise<void> {
  if (readMessages.length === 0) return;

  const messagePreviews = readMessages
    .slice(0, 30)
    .map((m) => `${m.user}: ${truncateStr(m.text, 150)}`)
    .join("\n");

  const content = truncateStr(
    `[Channel read: #${channelName}] ${readMessages.length} messages\n${messagePreviews}`,
    MAX_TOOL_CONTENT_LENGTH,
  );

  const msg: NewMessage = {
    slackTs: `${ctx.parentTs}-chread-${ctx.toolIndex}`,
    slackThreadTs: ctx.threadTs || ctx.parentTs,
    channelId: ctx.channelId,
    channelType: ctx.channelType,
    userId: ctx.userId,
    role: "tool" as const,
    content,
    metadata: {
      source: "channel_read",
      tool_name: toolName,
      original_channel: channelName,
      messages_read: readMessages.length,
      read_at: new Date().toISOString(),
    },
  };

  try {
    await db
      .insert(messages)
      .values(msg)
      .onConflictDoNothing({ target: messages.slackTs });
    logger.info("Stored channel read message", {
      channel: channelName,
      messageCount: readMessages.length,
    });
  } catch (error) {
    logger.warn("Failed to store channel read message", {
      error: String(error),
      channel: channelName,
    });
  }
}


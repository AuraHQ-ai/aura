import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { messages, memories, eventLocks, type NewMessage, type NewMemory } from "../db/schema.js";
import { logger } from "../lib/logger.js";

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


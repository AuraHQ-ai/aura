import { eq, sql, isNull, and, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { messages, memories, notes, eventLocks, type NewMessage, type NewMemory } from "@aura/db/schema";
import { embedText, embedTexts } from "../lib/embeddings.js";
import { logger } from "../lib/logger.js";
import { importanceToRelevance } from "./importance.js";
import type { ToolCallRecord } from "../pipeline/respond.js";
import type { ChannelType } from "../pipeline/context.js";

export type DbChannelType = "dm" | "public_channel" | "private_channel" | "dashboard";

export function toDbChannelType(ct: ChannelType | "dashboard"): DbChannelType {
  if (ct === "dm" || ct === "public_channel" || ct === "private_channel" || ct === "dashboard") return ct;
  return "public_channel";
}

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

export interface ThreadMessage {
  role: string;
  userId: string;
  content: string;
  createdAt: Date;
}

/**
 * Fetch all persisted messages for a Slack thread, ordered chronologically.
 * Used by memory extraction to build thread-scoped context.
 */
export async function fetchThreadMessages(params: {
  channelId: string;
  threadTs: string;
  limit?: number;
}): Promise<ThreadMessage[]> {
  const { channelId, threadTs, limit = 30 } = params;
  try {
    const rows = await db
      .select({
        role: messages.role,
        userId: messages.userId,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          sql`(${messages.slackThreadTs} = ${threadTs} OR ${messages.slackTs} = ${threadTs})`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    return rows.reverse();
  } catch (error) {
    logger.warn("Failed to fetch thread messages for extraction", {
      error: String(error),
      channelId,
      threadTs,
    });
    return [];
  }
}

/**
 * Store a raw message (user or assistant) to the messages table.
 * Generates and stores a vector embedding for semantic search.
 *
 * Uses `externalId` as the dedup key. For Slack, pass the slack_ts.
 * For other channels, pass a unique identifier (e.g. UUID).
 */
export async function storeMessage(message: Omit<NewMessage, 'channelType'> & { channelType: ChannelType | "dashboard" }): Promise<string> {
  try {
    let embedding: number[] | null = null;
    if (message.content && message.content.trim().length > 0) {
      try {
        embedding = await embedText(message.content);
      } catch (error) {
        logger.error("Failed to embed message — storing without embedding", {
          error: String(error),
          externalId: message.externalId,
          contentLength: message.content.length,
        });
      }
    }

    const [inserted] = await db
      .insert(messages)
      .values({ ...message, channelType: toDbChannelType(message.channelType), embedding })
      .onConflictDoNothing({ target: [messages.workspaceId, messages.externalId] })
      .returning({ id: messages.id });

    if (inserted) {
      logger.info("Stored message", {
        id: inserted.id,
        role: message.role,
        hasEmbedding: embedding !== null,
        embeddingDims: embedding?.length,
      });
      return inserted.id;
    }

    const existing = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.externalId, message.externalId))
      .limit(1);

    return existing[0]?.id ?? "";
  } catch (error) {
    logger.error("Failed to store message", {
      error: String(error),
      externalId: message.externalId,
    });
    throw error;
  }
}

/**
 * Backfill embeddings for existing messages that don't have them.
 * Processes in batches to avoid overwhelming the embedding API.
 */
export async function backfillMessageEmbeddings(
  batchSize = 50,
  onProgress?: (completed: number, total: number) => void,
): Promise<number> {
  let totalEmbedded = 0;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        isNull(messages.embedding),
        sql`${messages.content} IS NOT NULL AND length(${messages.content}) > 0`,
      ),
    );
  const total = count;

  try {
    while (true) {
      const batch = await db
        .select({ id: messages.id, content: messages.content })
        .from(messages)
        .where(
          and(
            isNull(messages.embedding),
            sql`${messages.content} IS NOT NULL AND length(${messages.content}) > 0`,
          ),
        )
        .limit(batchSize);

      if (batch.length === 0) break;

      const texts = batch.map((m) => m.content);
      const embeddings = await embedTexts(texts);

      for (let i = 0; i < batch.length; i++) {
        await db
          .update(messages)
          .set({ embedding: embeddings[i] })
          .where(eq(messages.id, batch[i].id));
      }

      totalEmbedded += batch.length;
      onProgress?.(totalEmbedded, total);
      logger.info(`Backfilled ${totalEmbedded} message embeddings so far`);
    }

    logger.info(`Backfill complete: embedded ${totalEmbedded} messages`);
    return totalEmbedded;
  } catch (error) {
    logger.error("Message embedding backfill failed", {
      error: String(error),
      totalEmbeddedBeforeFailure: totalEmbedded,
    });
    throw error;
  }
}

/**
 * Backfill embeddings for existing memories that don't have them.
 * Processes in batches to avoid overwhelming the embedding API.
 */
export async function backfillMemoryEmbeddings(
  batchSize = 50,
  onProgress?: (completed: number, total: number) => void,
): Promise<number> {
  let totalEmbedded = 0;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memories)
    .where(
      and(
        isNull(memories.embedding),
        sql`${memories.content} IS NOT NULL AND length(${memories.content}) > 0`,
      ),
    );
  const total = count;

  try {
    while (true) {
      const batch = await db
        .select({ id: memories.id, content: memories.content })
        .from(memories)
        .where(
          and(
            isNull(memories.embedding),
            sql`${memories.content} IS NOT NULL AND length(${memories.content}) > 0`,
          ),
        )
        .limit(batchSize);

      if (batch.length === 0) break;

      const texts = batch.map((m) => m.content);
      const embeddings = await embedTexts(texts);

      for (let i = 0; i < batch.length; i++) {
        await db
          .update(memories)
          .set({ embedding: embeddings[i] })
          .where(eq(memories.id, batch[i].id));
      }

      totalEmbedded += batch.length;
      onProgress?.(totalEmbedded, total);
      logger.info(`Backfilled ${totalEmbedded} memory embeddings so far`);
    }

    logger.info(`Memory backfill complete: embedded ${totalEmbedded} memories`);
    return totalEmbedded;
  } catch (error) {
    logger.error("Memory embedding backfill failed", {
      error: String(error),
      totalEmbeddedBeforeFailure: totalEmbedded,
    });
    throw error;
  }
}

/**
 * Backfill embeddings for existing notes that don't have them.
 * Processes in batches to avoid overwhelming the embedding API.
 */
export async function backfillNoteEmbeddings(
  batchSize = 50,
  onProgress?: (completed: number, total: number) => void,
): Promise<number> {
  let totalEmbedded = 0;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notes)
    .where(
      and(
        isNull(notes.embedding),
        sql`${notes.content} IS NOT NULL AND length(${notes.content}) > 0`,
      ),
    );
  const total = count;

  try {
    while (true) {
      const batch = await db
        .select({ id: notes.id, content: notes.content })
        .from(notes)
        .where(
          and(
            isNull(notes.embedding),
            sql`${notes.content} IS NOT NULL AND length(${notes.content}) > 0`,
          ),
        )
        .limit(batchSize);

      if (batch.length === 0) break;

      const texts = batch.map((n) => n.content);
      const embeddings = await embedTexts(texts);

      for (let i = 0; i < batch.length; i++) {
        await db
          .update(notes)
          .set({ embedding: embeddings[i] })
          .where(eq(notes.id, batch[i].id));
      }

      totalEmbedded += batch.length;
      onProgress?.(totalEmbedded, total);
      logger.info(`Backfilled ${totalEmbedded} note embeddings so far`);
    }

    logger.info(`Note backfill complete: embedded ${totalEmbedded} notes`);
    return totalEmbedded;
  } catch (error) {
    logger.error("Note embedding backfill failed", {
      error: String(error),
      totalEmbeddedBeforeFailure: totalEmbedded,
    });
    throw error;
  }
}

/**
 * Deduplication result for a single candidate memory.
 * - `dominated`: true if the candidate should be skipped entirely (similarity > 0.90)
 * - `supersedesId`: if similarity is 0.85–0.90, the ID of the old memory to soft-supersede
 */
export interface DedupResult {
  dominated: boolean;
  supersedesId?: string;
}

/**
 * Check candidate memories against existing memories using cosine similarity.
 * Returns a DedupResult per candidate:
 * - similarity > 0.90 → dominated (skip this candidate)
 * - similarity 0.85–0.90 → keep new, soft-supersede old (set relevance_score = 0.001)
 * - similarity < 0.85 → no match, insert normally
 */
export async function checkDuplicates(
  candidates: { content: string; embedding: number[] | null }[],
  workspaceId: string,
): Promise<DedupResult[]> {
  const results: DedupResult[] = [];

  for (const candidate of candidates) {
    if (!candidate.embedding) {
      results.push({ dominated: false });
      continue;
    }

    try {
      const vectorSql = sql.raw(`'[${candidate.embedding.join(",")}]'::vector`);
      const neighbors = await db.execute(sql`
        SELECT id, 1 - (embedding <=> ${vectorSql}) AS similarity
        FROM memories
        WHERE workspace_id = ${workspaceId}
          AND embedding IS NOT NULL
          AND relevance_score > 0.01
          AND status IN ('current', 'disputed')
        ORDER BY embedding <=> ${vectorSql}
        LIMIT 3
      `);

      const rows = ((neighbors as any).rows ?? neighbors) as Array<Record<string, any>>;

      let dominated = false;
      let supersedesId: string | undefined;

      for (const row of rows) {
        const sim = parseFloat(row.similarity);
        if (sim > 0.90) {
          dominated = true;
          break;
        }
        if (sim >= 0.85 && !supersedesId) {
          supersedesId = row.id;
        }
      }

      if (dominated) {
        results.push({ dominated: true });
      } else if (supersedesId) {
        results.push({ dominated: false, supersedesId });
      } else {
        results.push({ dominated: false });
      }
    } catch (error) {
      logger.warn("Dedup check failed for candidate — allowing through", {
        error: String(error),
        contentPreview: candidate.content.substring(0, 80),
      });
      results.push({ dominated: false });
    }
  }

  return results;
}

/**
 * Properly supersede an old memory with a new one using lifecycle transitions.
 * Sets old memory: status='superseded', superseded_at=now(), superseded_by_memory_id=newMemoryId, valid_until=now()
 * Sets new memory: status='current', valid_from=now(), supersedes_memory_id=oldMemoryId
 * Leaves relevance_score untouched — it's purely a recency/decay signal.
 */
export async function supersedeMemory(oldMemoryId: string, newMemoryId: string): Promise<void> {
  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE memories
        SET status = 'superseded',
            superseded_at = ${now},
            superseded_by_memory_id = ${newMemoryId}::uuid,
            valid_until = ${now},
            updated_at = ${now}
        WHERE id = ${oldMemoryId}::uuid
          AND status IN ('current', 'disputed')
      `);

      await tx.execute(sql`
        UPDATE memories
        SET status = 'current',
            valid_from = ${now},
            supersedes_memory_id = ${oldMemoryId}::uuid,
            updated_at = ${now}
        WHERE id = ${newMemoryId}::uuid
      `);
    });
  } catch (error) {
    logger.warn("Failed to supersede memory", {
      oldMemoryId,
      newMemoryId,
      error: String(error),
    });
  }
}

/**
 * Batch store multiple memories.
 * Automatically sets status='current' and validFrom=now() on all new memories.
 */
export async function storeMemories(newMemories: NewMemory[]): Promise<string[]> {
  if (newMemories.length === 0) return [];

  const now = new Date();
  const memoriesWithDefaults = newMemories.map((m) => ({
    ...m,
    status: m.status ?? ("current" as const),
    validFrom: m.validFrom ?? now,
  }));

  try {
    const inserted = await db
      .insert(memories)
      .values(memoriesWithDefaults)
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
  channelType: ChannelType;
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
    externalId: `${ctx.parentTs}-tool-${i}`,
    slackTs: `${ctx.parentTs}-tool-${i}`,
    slackThreadTs: ctx.threadTs || ctx.parentTs,
    channelId: ctx.channelId,
    channelType: toDbChannelType(ctx.channelType),
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
        .onConflictDoNothing({ target: [messages.workspaceId, messages.externalId] })
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
    externalId: `${ctx.parentTs}-chread-${ctx.toolIndex}`,
    slackTs: `${ctx.parentTs}-chread-${ctx.toolIndex}`,
    slackThreadTs: ctx.threadTs || ctx.parentTs,
    channelId: ctx.channelId,
    channelType: toDbChannelType(ctx.channelType),
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
      .onConflictDoNothing({ target: [messages.workspaceId, messages.externalId] });
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

/**
 * Update an existing memory's content and re-embed it.
 * Used by thread-scoped reconciliation when the LLM refines an existing memory.
 */
export async function updateMemoryContent(
  memoryId: string,
  newContent: string,
  newEmbedding: number[] | null,
  newImportance?: number,
): Promise<void> {
  const now = new Date();
  try {
    const updates: Record<string, unknown> = {
      content: newContent,
      embedding: newEmbedding,
      updatedAt: now,
    };
    if (newImportance != null) {
      updates.importance = newImportance;
      updates.relevanceScore = importanceToRelevance(newImportance);
    }
    await db
      .update(memories)
      .set(updates)
      .where(eq(memories.id, memoryId));
    logger.info("Updated memory content", { memoryId, contentLength: newContent.length });
  } catch (error) {
    logger.warn("Failed to update memory content", {
      memoryId,
      error: String(error),
    });
    throw error;
  }
}

/**
 * Archive a memory (soft delete). Sets status='archived'.
 * Used by thread-scoped reconciliation when the LLM determines a memory is outdated.
 */
export async function archiveMemory(
  memoryId: string,
  reason: string,
): Promise<void> {
  const now = new Date();
  try {
    await db
      .update(memories)
      .set({ status: "archived", updatedAt: now })
      .where(eq(memories.id, memoryId));
    logger.info("Archived memory", { memoryId, reason });
  } catch (error) {
    logger.warn("Failed to archive memory", {
      memoryId,
      reason,
      error: String(error),
    });
  }
}


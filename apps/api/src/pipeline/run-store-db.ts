/**
 * Drizzle-backed {@link RunStore} for dashboard chat runs.
 */

import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { UIMessageChunk } from "ai";
import { chatRuns, chatRunChunks } from "@aura/db/schema";
import { db } from "../db/client.js";
import type { ChatRunRecord, ChatRunStatus, RunStore, StoredChunk } from "./run-store.js";

function toRecord(row: typeof chatRuns.$inferSelect): ChatRunRecord {
  return {
    id: row.id,
    threadId: row.threadId,
    userId: row.userId,
    modelId: row.modelId,
    status: row.status as ChatRunStatus,
    inputMessages: row.inputMessages,
    error: row.error,
  };
}

export const dbRunStore: RunStore = {
  async createRun(input) {
    const [row] = await db
      .insert(chatRuns)
      .values({
        threadId: input.threadId,
        userId: input.userId ?? null,
        modelId: input.modelId ?? null,
        status: "running",
        inputMessages: input.inputMessages ?? null,
      })
      .returning({ id: chatRuns.id });
    return row!.id;
  },

  async appendChunk(runId, seq, chunk) {
    await db
      .insert(chatRunChunks)
      .values({ runId, seq, chunk: chunk as unknown })
      .onConflictDoNothing();
  },

  async getChunks(runId, fromSeq): Promise<StoredChunk[]> {
    const rows = await db
      .select({ seq: chatRunChunks.seq, chunk: chatRunChunks.chunk })
      .from(chatRunChunks)
      .where(and(eq(chatRunChunks.runId, runId), gte(chatRunChunks.seq, fromSeq)))
      .orderBy(asc(chatRunChunks.seq));
    return rows.map((r) => ({ seq: r.seq, chunk: r.chunk as UIMessageChunk }));
  },

  async getTailIndex(runId) {
    const [row] = await db
      .select({ maxSeq: sql<number | null>`max(${chatRunChunks.seq})` })
      .from(chatRunChunks)
      .where(eq(chatRunChunks.runId, runId));
    const maxSeq = row?.maxSeq ?? null;
    return maxSeq == null ? 0 : Number(maxSeq) + 1;
  },

  async getRun(runId) {
    const [row] = await db.select().from(chatRuns).where(eq(chatRuns.id, runId)).limit(1);
    return row ? toRecord(row) : null;
  },

  async finishRun(runId, status, error) {
    await db
      .update(chatRuns)
      .set({
        status,
        error: error ?? null,
        updatedAt: new Date(),
        finishedAt: new Date(),
      })
      .where(and(eq(chatRuns.id, runId), eq(chatRuns.status, "running")));
  },

  async requestCancel(runId) {
    await db
      .update(chatRuns)
      .set({ status: "canceled", updatedAt: new Date(), finishedAt: new Date() })
      .where(and(eq(chatRuns.id, runId), eq(chatRuns.status, "running")));
  },

  async getActiveRunForThread(runThreadId) {
    const [row] = await db
      .select()
      .from(chatRuns)
      .where(and(eq(chatRuns.threadId, runThreadId), eq(chatRuns.status, "running")))
      .orderBy(desc(chatRuns.createdAt))
      .limit(1);
    return row ? toRecord(row) : null;
  },

  async getGeneratingThreads(threadIds) {
    if (threadIds.length === 0) return new Set<string>();
    const rows = await db
      .selectDistinct({ threadId: chatRuns.threadId })
      .from(chatRuns)
      .where(and(inArray(chatRuns.threadId, threadIds), eq(chatRuns.status, "running")));
    return new Set(rows.map((r) => r.threadId));
  },
};

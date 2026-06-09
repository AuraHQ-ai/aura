import type { UIMessageChunk } from "ai";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { dashboardChatChunks, dashboardChatRuns } from "@aura/db/schema";
import { db } from "../db/client.js";
import type {
  DashboardRunRecord,
  DashboardRunStatus,
  DashboardRunStore,
  StoredDashboardChunk,
} from "./dashboard-run-store.js";

const WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || "default";

function toRecord(row: typeof dashboardChatRuns.$inferSelect): DashboardRunRecord {
  return {
    id: row.id,
    threadId: row.threadId,
    userId: row.userId,
    userName: row.userName,
    messageId: row.messageId,
    prompt: row.prompt,
    inputMessages: row.inputMessages,
    modelId: row.modelId,
    status: row.status as DashboardRunStatus,
    error: row.error,
  };
}

export const dbDashboardRunStore: DashboardRunStore = {
  async createRun(input) {
    const id = input.id ?? crypto.randomUUID();
    await db.insert(dashboardChatRuns).values({
      id,
      workspaceId: WORKSPACE_ID,
      threadId: input.threadId,
      status: "generating",
      userId: input.userId,
      userName: input.userName ?? null,
      messageId: input.messageId,
      prompt: input.prompt,
      inputMessages: input.inputMessages ?? null,
      modelId: input.modelId ?? null,
    });
    return id;
  },

  async updateModelId(runId, modelId) {
    await db
      .update(dashboardChatRuns)
      .set({ modelId, updatedAt: sql`now()` })
      .where(
        and(
          eq(dashboardChatRuns.workspaceId, WORKSPACE_ID),
          eq(dashboardChatRuns.id, runId),
        ),
      );
  },

  async appendChunk(runId, chunkIndex, chunk) {
    await db
      .insert(dashboardChatChunks)
      .values({
        workspaceId: WORKSPACE_ID,
        runId,
        chunkIndex,
        chunk,
      })
      .onConflictDoNothing();

    await db
      .update(dashboardChatRuns)
      .set({ updatedAt: sql`now()` })
      .where(
        and(
          eq(dashboardChatRuns.workspaceId, WORKSPACE_ID),
          eq(dashboardChatRuns.id, runId),
        ),
      );
  },

  async getChunks(runId, fromIndex): Promise<StoredDashboardChunk[]> {
    const rows = await db
      .select({
        chunkIndex: dashboardChatChunks.chunkIndex,
        chunk: dashboardChatChunks.chunk,
      })
      .from(dashboardChatChunks)
      .where(
        and(
          eq(dashboardChatChunks.workspaceId, WORKSPACE_ID),
          eq(dashboardChatChunks.runId, runId),
          sql`${dashboardChatChunks.chunkIndex} >= ${fromIndex}`,
        ),
      )
      .orderBy(asc(dashboardChatChunks.chunkIndex));

    return rows.map((row) => ({
      chunkIndex: row.chunkIndex,
      chunk: row.chunk as UIMessageChunk,
    }));
  },

  async getTailIndex(runId) {
    const [row] = await db
      .select({
        tailIndex: sql<number>`coalesce(max(${dashboardChatChunks.chunkIndex}), -1)::int`,
      })
      .from(dashboardChatChunks)
      .where(
        and(
          eq(dashboardChatChunks.workspaceId, WORKSPACE_ID),
          eq(dashboardChatChunks.runId, runId),
        ),
      );

    return row?.tailIndex ?? -1;
  },

  async getRun(runId) {
    const [row] = await db
      .select()
      .from(dashboardChatRuns)
      .where(
        and(
          eq(dashboardChatRuns.workspaceId, WORKSPACE_ID),
          eq(dashboardChatRuns.id, runId),
        ),
      )
      .limit(1);

    return row ? toRecord(row) : null;
  },

  async finishRun(runId, status, error) {
    await db
      .update(dashboardChatRuns)
      .set({
        status,
        error: error ?? null,
        updatedAt: sql`now()`,
        completedAt: status === "generating" ? null : sql`now()`,
      })
      .where(
        and(
          eq(dashboardChatRuns.workspaceId, WORKSPACE_ID),
          eq(dashboardChatRuns.id, runId),
          eq(dashboardChatRuns.status, "generating"),
        ),
      );
  },

  async requestCancel(runId) {
    await db
      .update(dashboardChatRuns)
      .set({
        status: "cancelled",
        updatedAt: sql`now()`,
        completedAt: sql`now()`,
      })
      .where(
        and(
          eq(dashboardChatRuns.workspaceId, WORKSPACE_ID),
          eq(dashboardChatRuns.id, runId),
          eq(dashboardChatRuns.status, "generating"),
        ),
      );
  },

  async getActiveRunForThread(threadId) {
    const [row] = await db
      .select()
      .from(dashboardChatRuns)
      .where(
        and(
          eq(dashboardChatRuns.workspaceId, WORKSPACE_ID),
          eq(dashboardChatRuns.threadId, threadId),
          eq(dashboardChatRuns.status, "generating"),
        ),
      )
      .orderBy(desc(dashboardChatRuns.updatedAt))
      .limit(1);

    return row ? toRecord(row) : null;
  },
};

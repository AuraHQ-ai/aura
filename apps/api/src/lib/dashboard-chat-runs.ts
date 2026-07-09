import { and, desc, eq, inArray } from "drizzle-orm";
import { dashboardChatRuns } from "@aura/db/schema";
import { db } from "../db/client.js";
import { logger } from "./logger.js";

export type DashboardChatRunStatus = "running" | "completed" | "failed" | "cancelled";

/** Record a new workflow run for a dashboard chat thread (R4: server-anchored). */
export async function recordDashboardChatRun(params: {
  threadId: string;
  runId: string;
  userId: string;
  /** The user message starting this turn — rendered as the in-flight user
   * bubble (and thread preview) for sessions that attach mid-generation. */
  userMessage?: string;
}): Promise<void> {
  await db.insert(dashboardChatRuns).values({
    threadId: params.threadId,
    runId: params.runId,
    userId: params.userId,
    userMessage: params.userMessage ?? null,
    status: "running",
  });
}

/** Mark a run row terminal. Called from the workflow's final step. */
export async function markDashboardChatRunFinished(
  runId: string,
  status: Exclude<DashboardChatRunStatus, "running">,
): Promise<void> {
  try {
    await db
      .update(dashboardChatRuns)
      .set({ status, completedAt: new Date() })
      .where(eq(dashboardChatRuns.runId, runId));
  } catch (error) {
    logger.error("Failed to mark dashboard chat run finished", {
      runId,
      status,
      error: String(error),
    });
  }
}

export interface ThreadRunInfo {
  threadId: string;
  runId: string;
  userId: string;
  status: DashboardChatRunStatus;
  userMessage: string | null;
}

/**
 * Resolve the latest run per thread, reconciling rows still marked "running"
 * against the workflow backend (R2: the workflow run state is the source of
 * truth — a row can be stale if the run crashed before its final step).
 */
export async function getLatestRunsForThreads(
  threadIds: string[],
): Promise<Map<string, ThreadRunInfo>> {
  const result = new Map<string, ThreadRunInfo>();
  if (threadIds.length === 0) return result;

  const rows = await db
    .select({
      threadId: dashboardChatRuns.threadId,
      runId: dashboardChatRuns.runId,
      userId: dashboardChatRuns.userId,
      status: dashboardChatRuns.status,
      userMessage: dashboardChatRuns.userMessage,
      createdAt: dashboardChatRuns.createdAt,
    })
    .from(dashboardChatRuns)
    .where(inArray(dashboardChatRuns.threadId, threadIds))
    .orderBy(desc(dashboardChatRuns.createdAt));

  for (const row of rows) {
    if (result.has(row.threadId)) continue;
    result.set(row.threadId, {
      threadId: row.threadId,
      runId: row.runId,
      userId: row.userId,
      status: row.status as DashboardChatRunStatus,
      userMessage: row.userMessage,
    });
  }

  // Reconcile "running" rows against the workflow backend.
  const unfinished = [...result.values()].filter((r) => r.status === "running");
  await Promise.all(
    unfinished.map(async (info) => {
      const live = await getLiveRunStatus(info.runId);
      if (!live) return;
      if (live !== "running" && live !== "pending") {
        const terminal: DashboardChatRunStatus =
          live === "completed" ? "completed" : live === "cancelled" ? "cancelled" : "failed";
        info.status = terminal;
        await markDashboardChatRunFinished(info.runId, terminal);
      }
    }),
  );

  return result;
}

/** Look up the latest run row for a single thread (reconciled). */
export async function getLatestRunForThread(
  threadId: string,
): Promise<ThreadRunInfo | null> {
  const map = await getLatestRunsForThreads([threadId]);
  return map.get(threadId) ?? null;
}

async function getLiveRunStatus(runId: string): Promise<string | null> {
  try {
    const { getRun } = await import("workflow/api");
    return await getRun(runId).status;
  } catch (error) {
    logger.warn("Failed to read workflow run status", {
      runId,
      error: String(error),
    });
    return null;
  }
}

/** Find a run row by runId (for auth checks on stream/cancel endpoints). */
export async function getDashboardChatRun(runId: string) {
  const [row] = await db
    .select()
    .from(dashboardChatRuns)
    .where(eq(dashboardChatRuns.runId, runId))
    .limit(1);
  return row ?? null;
}

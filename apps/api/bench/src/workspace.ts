/**
 * Workspace lifecycle for the memory benchmark harness.
 *
 * Each bench run gets its own `bench-{runId}` workspace so extracted memories
 * never collide with production data. Results are written to a dedicated
 * `bench-meta` workspace that is never wiped.
 */

import { sql } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces } from "@aura/db/schema";
import { logger } from "../../src/lib/logger.js";

const BENCH_WORKSPACE_PREFIX = "bench-";
export const BENCH_META_WORKSPACE = "bench-meta";

/** Build the per-run workspace_id from a runId. */
export function benchWorkspaceId(runId: string): string {
  return `${BENCH_WORKSPACE_PREFIX}${runId}`;
}

/**
 * Insert the per-run workspace row and ensure the meta workspace exists.
 * Both are idempotent (ON CONFLICT DO NOTHING). Returns the per-run id.
 */
export async function createBenchWorkspace(runId: string): Promise<string> {
  const workspaceId = benchWorkspaceId(runId);
  await db
    .insert(workspaces)
    .values([
      {
        id: workspaceId,
        name: `Memory Bench Run ${runId}`,
        plan: "internal",
      },
      {
        id: BENCH_META_WORKSPACE,
        name: "Memory Bench Metadata",
        plan: "internal",
      },
    ])
    .onConflictDoNothing();
  logger.info("Bench workspace ready", { workspaceId });
  return workspaceId;
}

/**
 * Delete all data in a single bench workspace. Called at the end of a run
 * to free space — bench memories balloon fast.
 *
 * Order matters: junction tables → memories/messages → entities. Drizzle's
 * cascade-delete on `memory_entities` covers most of the dependency graph,
 * but we are explicit to keep things idempotent.
 */
export async function wipeBenchWorkspace(workspaceId: string): Promise<void> {
  if (!workspaceId.startsWith(BENCH_WORKSPACE_PREFIX)) {
    throw new Error(
      `Refusing to wipe non-bench workspace_id="${workspaceId}". Bench wipe requires bench-* prefix.`,
    );
  }
  if (workspaceId === BENCH_META_WORKSPACE) {
    throw new Error("Refusing to wipe bench-meta — that's where scores live.");
  }

  logger.info("Wiping bench workspace", { workspaceId });

  // Use raw SQL so we don't have to import every leaf table here. Each
  // statement is independent; failures on one shouldn't abort the rest.
  const tables = [
    "memory_entities",
    "memories",
    "messages",
    "entity_aliases",
    "entities",
  ];
  for (const table of tables) {
    try {
      await db.execute(
        sql`DELETE FROM ${sql.identifier(table)} WHERE workspace_id = ${workspaceId}`,
      );
    } catch (error) {
      logger.warn(`wipeBenchWorkspace: ${table} delete failed (continuing)`, {
        workspaceId,
        error: String(error).slice(0, 200),
      });
    }
  }

  try {
    await db.execute(
      sql`DELETE FROM workspaces WHERE id = ${workspaceId}`,
    );
  } catch (error) {
    logger.warn("wipeBenchWorkspace: workspace row delete failed", {
      workspaceId,
      error: String(error).slice(0, 200),
    });
  }
}

/**
 * Garbage-collect bench workspaces older than the cutoff (default 7 days).
 * Safe to call at the start of every run — it's a no-op if nothing is stale.
 *
 * Per #1043 the harness creates a fresh workspace each run; this protects
 * against orphans from crashed runs.
 */
export async function gcStaleBenchWorkspaces(cutoffDays = 7): Promise<number> {
  const result = await db.execute(sql`
    SELECT id FROM workspaces
    WHERE id LIKE ${`${BENCH_WORKSPACE_PREFIX}%`}
      AND id != ${BENCH_META_WORKSPACE}
      AND installed_at < now() - (${cutoffDays} || ' days')::interval
  `);
  const rows = ((result as any).rows ?? result) as Array<{ id: string }>;
  for (const row of rows) {
    await wipeBenchWorkspace(row.id);
  }
  if (rows.length > 0) {
    logger.info(`GC'd ${rows.length} stale bench workspace(s)`, {
      cutoffDays,
    });
  }
  return rows.length;
}

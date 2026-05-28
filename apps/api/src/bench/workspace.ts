import { sql, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { workspaces, memories, messages, memoryEntities, entities } from "@aura/db/schema";
import { logger } from "../../src/lib/logger.js";

export const BENCH_META_WORKSPACE_ID = "bench-meta";

const BENCH_META_NAME = "Memory benchmark results";

/** Ensure bench-meta workspace exists (never wiped). */
export async function ensureBenchMetaWorkspace(): Promise<void> {
  await db
    .insert(workspaces)
    .values({ id: BENCH_META_WORKSPACE_ID, name: BENCH_META_NAME })
    .onConflictDoNothing();
}

export async function createBenchWorkspace(runId: string): Promise<string> {
  const workspaceId = `bench-${runId}`;
  await db
    .insert(workspaces)
    .values({ id: workspaceId, name: `Bench run ${runId}` })
    .onConflictDoNothing();
  return workspaceId;
}

/** Delete bench workspaces older than 7 days (not bench-meta). */
export async function cleanupStaleBenchWorkspaces(): Promise<number> {
  const stale = await db.execute(sql`
    SELECT id FROM workspaces
    WHERE id LIKE 'bench-%'
      AND id != ${BENCH_META_WORKSPACE_ID}
      AND installed_at < now() - interval '7 days'
  `);
  const rows = (((stale as { rows?: unknown }).rows ?? stale) as { id: string }[]);
  let deleted = 0;
  for (const { id } of rows) {
    await wipeBenchWorkspace(id);
    await db.delete(workspaces).where(eq(workspaces.id, id));
    deleted++;
  }
  if (deleted > 0) {
    logger.info(`Cleaned up ${deleted} stale bench workspace(s)`);
  }
  return deleted;
}

export async function wipeBenchWorkspace(workspaceId: string): Promise<void> {
  if (workspaceId === BENCH_META_WORKSPACE_ID) {
    throw new Error("Refusing to wipe bench-meta workspace");
  }

  const memIds = await db
    .select({ id: memories.id })
    .from(memories)
    .where(eq(memories.workspaceId, workspaceId));

  if (memIds.length > 0) {
    const idList = sql.join(
      memIds.map((m) => sql`${m.id}`),
      sql`, `,
    );
    await db.execute(sql`DELETE FROM memory_entities WHERE memory_id IN (${idList})`);
  }

  await db.delete(memories).where(eq(memories.workspaceId, workspaceId));
  await db.delete(messages).where(eq(messages.workspaceId, workspaceId));

  await db.execute(sql`
    DELETE FROM entities e
    WHERE e.workspace_id = ${workspaceId}
  `);
}

import { sql } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces } from "@aura/db/schema";

export const BENCH_META_WORKSPACE_ID = "bench-meta";

export function makeRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

export function benchWorkspaceId(runId: string): string {
  return `bench-${runId}`;
}

export async function ensureBenchMetaWorkspace(): Promise<void> {
  await db
    .insert(workspaces)
    .values({
      id: BENCH_META_WORKSPACE_ID,
      name: "Memory benchmark metadata",
      plan: "internal",
    })
    .onConflictDoNothing();
}

export async function createBenchWorkspace(workspaceId: string): Promise<void> {
  await ensureBenchMetaWorkspace();
  await db
    .insert(workspaces)
    .values({
      id: workspaceId,
      name: `Memory benchmark ${workspaceId}`,
      plan: "internal",
    })
    .onConflictDoNothing();
}

export async function wipeBenchWorkspace(workspaceId: string): Promise<void> {
  if (!workspaceId.startsWith("bench-") || workspaceId === BENCH_META_WORKSPACE_ID) {
    throw new Error(`Refusing to wipe non-run workspace: ${workspaceId}`);
  }

  await db.execute(sql`
    DELETE FROM memory_entities
    WHERE memory_id IN (SELECT id FROM memories WHERE workspace_id = ${workspaceId})
  `);
  await db.execute(sql`
    DELETE FROM entity_aliases
    WHERE entity_id IN (SELECT id FROM entities WHERE workspace_id = ${workspaceId})
  `);
  await db.execute(sql`DELETE FROM memories WHERE workspace_id = ${workspaceId}`);
  await db.execute(sql`DELETE FROM messages WHERE workspace_id = ${workspaceId}`);
  await db.execute(sql`DELETE FROM entities WHERE workspace_id = ${workspaceId}`);
  await db.execute(sql`DELETE FROM users WHERE workspace_id = ${workspaceId}`);
  await db.execute(sql`DELETE FROM workspaces WHERE id = ${workspaceId}`);
}

export async function pruneOldBenchWorkspaces(): Promise<void> {
  await db.execute(sql`
    DELETE FROM memory_entities
    WHERE memory_id IN (
      SELECT id FROM memories
      WHERE workspace_id LIKE 'bench-%'
        AND workspace_id <> ${BENCH_META_WORKSPACE_ID}
        AND created_at < now() - interval '7 days'
    )
  `);
  await db.execute(sql`
    DELETE FROM entity_aliases
    WHERE entity_id IN (
      SELECT id FROM entities
      WHERE workspace_id LIKE 'bench-%'
        AND workspace_id <> ${BENCH_META_WORKSPACE_ID}
        AND created_at < now() - interval '7 days'
    )
  `);
  await db.execute(sql`
    DELETE FROM memories
    WHERE workspace_id LIKE 'bench-%'
      AND workspace_id <> ${BENCH_META_WORKSPACE_ID}
      AND created_at < now() - interval '7 days'
  `);
  await db.execute(sql`
    DELETE FROM messages
    WHERE workspace_id LIKE 'bench-%'
      AND workspace_id <> ${BENCH_META_WORKSPACE_ID}
      AND created_at < now() - interval '7 days'
  `);
  await db.execute(sql`
    DELETE FROM entities
    WHERE workspace_id LIKE 'bench-%'
      AND workspace_id <> ${BENCH_META_WORKSPACE_ID}
      AND created_at < now() - interval '7 days'
  `);
  await db.execute(sql`
    DELETE FROM users
    WHERE workspace_id LIKE 'bench-%'
      AND workspace_id <> ${BENCH_META_WORKSPACE_ID}
      AND created_at < now() - interval '7 days'
  `);
  await db.execute(sql`
    DELETE FROM workspaces
    WHERE id LIKE 'bench-%'
      AND id <> ${BENCH_META_WORKSPACE_ID}
      AND NOT EXISTS (
        SELECT 1 FROM memories WHERE memories.workspace_id = workspaces.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM messages WHERE messages.workspace_id = workspaces.id
      )
  `);
}

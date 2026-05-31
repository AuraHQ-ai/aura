/**
 * Backfill `memories.linked_memory_ids` (#1054).
 *
 * Two memories are "linked" when they share at least one resolved entity (via
 * `memory_entities`), scoped to the same workspace. This materializes that
 * adjacency so the retrieval ranker can apply a graph-expansion boost without a
 * join at read time. New writes maintain the column via
 * `updateLinkedMemoryIds()` in the extractor; this script populates pre-existing
 * rows once.
 *
 * Set-based and workspace-batched (one UPDATE per workspace) to bound memory on
 * large tenants. Idempotent — re-running recomputes the same sets.
 *
 * Run:
 *   pnpm --filter @aura/db exec tsx scripts/backfill-linked-memory-ids.ts
 * (wrap with ./scripts/env.sh / --prod to target a specific database)
 */

import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const MAX_LINKS = 25;
const sql = neon(DATABASE_URL);

async function run() {
  const col = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'linked_memory_ids'
  `;
  if (col.length === 0) {
    console.error("linked_memory_ids column missing — run migrations first.");
    process.exit(1);
  }

  const workspaces = await sql`
    SELECT DISTINCT workspace_id FROM memories WHERE workspace_id IS NOT NULL
  `;
  console.log(`Backfilling linked_memory_ids across ${workspaces.length} workspace(s)…`);

  let totalUpdated = 0;
  for (const { workspace_id: workspaceId } of workspaces as Array<{ workspace_id: string }>) {
    const updated = await sql`
      WITH neighbors AS (
        SELECT me1.memory_id AS memory_id,
               (array_agg(DISTINCT me2.memory_id))[1:${MAX_LINKS}] AS linked
        FROM memory_entities me1
        JOIN memory_entities me2
          ON me2.entity_id = me1.entity_id AND me2.memory_id <> me1.memory_id
        JOIN memories m1 ON m1.id = me1.memory_id AND m1.workspace_id = ${workspaceId}
        JOIN memories m2 ON m2.id = me2.memory_id AND m2.workspace_id = ${workspaceId}
        GROUP BY me1.memory_id
      )
      UPDATE memories
      SET linked_memory_ids = COALESCE(n.linked, '{}'::uuid[])
      FROM neighbors n
      WHERE memories.id = n.memory_id
        AND memories.workspace_id = ${workspaceId}
      RETURNING memories.id
    `;
    totalUpdated += updated.length;
    console.log(`  ${workspaceId}: linked ${updated.length} memories`);
  }

  console.log(`Done. Updated ${totalUpdated} memories total.`);
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});

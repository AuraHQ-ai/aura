import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

async function run() {
  // Step 0: Check current state
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM memories`;
  console.log(`Total memories: ${count}`);

  const colCheck = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'search_vector'
  `;
  const columnExists = colCheck.length > 0;
  console.log(`search_vector column exists: ${columnExists}`);

  if (columnExists) {
    const [{ nulls }] = await sql`
      SELECT count(*)::int AS nulls FROM memories WHERE search_vector IS NULL
    `;
    console.log(`Rows with NULL search_vector: ${nulls}`);
    if (nulls === 0) {
      console.log("Nothing to do — column exists and is fully populated.");
      return;
    }
  }

  // Step 1: Add column as a regular tsvector (NOT generated)
  // A GENERATED STORED column forces Postgres to rewrite every row in one
  // transaction, which can timeout on serverless. Instead, add a plain column
  // and backfill in batches, then add a trigger for future writes.
  console.log("\n── Step 1: Adding search_vector column ──");
  await sql`
    ALTER TABLE memories
    ADD COLUMN IF NOT EXISTS search_vector tsvector
  `;
  console.log("Column added.");

  // Step 2: Backfill in batches
  console.log("\n── Step 2: Backfilling search_vector ──");
  const BATCH_SIZE = 500;
  let totalUpdated = 0;

  const [{ nullCount }] = await sql`SELECT count(*)::int AS "nullCount" FROM memories WHERE search_vector IS NULL`;
  const toBackfill = nullCount as number;
  const startTime = Date.now();

  function formatDuration(ms: number): string {
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60) return `${min}m ${sec}s`;
    const hrs = Math.floor(min / 60);
    return `${hrs}h ${min % 60}m ${sec}s`;
  }

  while (true) {
    await sql`
      UPDATE memories
      SET search_vector = to_tsvector('english', coalesce(content, ''))
      WHERE id IN (
        SELECT id FROM memories
        WHERE search_vector IS NULL
        LIMIT ${BATCH_SIZE}
      )
    `;

    const batchResult = await sql`
      SELECT count(*)::int AS remaining FROM memories WHERE search_vector IS NULL
    `;
    const remaining = batchResult[0].remaining as number;
    totalUpdated = toBackfill - remaining;

    const elapsed = Date.now() - startTime;
    const pct = toBackfill > 0 ? ((totalUpdated / toBackfill) * 100).toFixed(1) : "0.0";
    let eta = "—";
    if (totalUpdated > 0 && remaining > 0) {
      eta = formatDuration((elapsed / totalUpdated) * remaining);
    }
    console.log(
      `  [${totalUpdated}/${toBackfill}] ${pct}% | elapsed ${formatDuration(elapsed)} | ETA ${eta}`,
    );

    if (remaining === 0) break;
  }
  console.log(`Backfill complete: ${totalUpdated} rows updated.`);

  // Step 3: Create trigger to keep search_vector in sync on future writes
  console.log("\n── Step 3: Creating trigger for future writes ──");
  await sql`
    CREATE OR REPLACE FUNCTION memories_search_vector_update()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english', coalesce(NEW.content, ''));
      RETURN NEW;
    END;
    $$
  `;
  await sql`
    DROP TRIGGER IF EXISTS trg_memories_search_vector ON memories
  `;
  await sql`
    CREATE TRIGGER trg_memories_search_vector
    BEFORE INSERT OR UPDATE OF content ON memories
    FOR EACH ROW
    EXECUTE FUNCTION memories_search_vector_update()
  `;
  console.log("Trigger created.");

  // Step 4: Create GIN index for fast full-text search
  console.log("\n── Step 4: Creating GIN index ──");
  await sql`
    CREATE INDEX IF NOT EXISTS memories_search_vector_idx
    ON memories USING gin (search_vector)
  `;
  console.log("GIN index created.");

  // Step 5: Create rrf_score helper function
  console.log("\n── Step 5: Creating rrf_score function ──");
  await sql`
    CREATE OR REPLACE FUNCTION rrf_score(rank bigint, rrf_k int DEFAULT 60)
    RETURNS numeric LANGUAGE SQL IMMUTABLE PARALLEL SAFE
    AS $fn$ SELECT COALESCE(1.0 / ($1 + $2), 0.0); $fn$
  `;
  console.log("rrf_score function created.");

  // Verify
  console.log("\n── Verification ──");
  const [verification] = await sql`
    SELECT
      count(*)::int AS total,
      count(search_vector)::int AS with_vector,
      count(*) FILTER (WHERE search_vector IS NULL)::int AS without_vector
    FROM memories
  `;
  console.log(`Total: ${verification.total}, with search_vector: ${verification.with_vector}, without: ${verification.without_vector}`);

  const testSearch = await sql`
    SELECT id, ts_rank_cd(search_vector, plainto_tsquery('english', 'test')) AS rank
    FROM memories
    WHERE search_vector @@ plainto_tsquery('english', 'test')
    LIMIT 3
  `;
  console.log(`Test search for "test": ${testSearch.length} results`);

  console.log("\n✓ All done! Hybrid search should now work.");
}

run().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

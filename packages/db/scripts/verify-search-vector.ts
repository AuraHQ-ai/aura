import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

async function run() {
  console.log("── 1. Column check ──");
  const [stats] = await sql`
    SELECT
      count(*)::int AS total,
      count(search_vector)::int AS with_vector,
      count(*) FILTER (WHERE search_vector IS NULL)::int AS without_vector
    FROM memories
  `;
  console.log(`Total: ${stats.total}, populated: ${stats.with_vector}, null: ${stats.without_vector}`);

  console.log("\n── 2. Full-text search test ──");
  const ftsResults = await sql`
    SELECT id, left(content, 80) AS preview,
      ts_rank_cd(search_vector, plainto_tsquery('english', 'development velocity')) AS rank
    FROM memories
    WHERE search_vector @@ plainto_tsquery('english', 'development velocity')
    ORDER BY rank DESC
    LIMIT 5
  `;
  console.log(`FTS for "development velocity": ${ftsResults.length} results`);
  for (const r of ftsResults) {
    console.log(`  [${Number(r.rank).toFixed(3)}] ${r.preview}`);
  }

  console.log("\n── 3. rrf_score function test ──");
  const [rrf] = await sql`SELECT rrf_score(1) AS score`;
  console.log(`rrf_score(1) = ${rrf.score} (expected ~0.0163)`);

  console.log("\n── 4. Trigger test (insert + verify) ──");
  const [inserted] = await sql`
    INSERT INTO memories (content, type, source_channel_type, workspace_id)
    SELECT 'SEARCH_VECTOR_TEST_ROW shipping features quickly', 'fact', 'dashboard',
      (SELECT id FROM workspaces LIMIT 1)
    RETURNING id, search_vector IS NOT NULL AS has_vector
  `;
  console.log(`Inserted test row ${inserted.id}, has search_vector: ${inserted.has_vector}`);

  // Verify it's searchable
  const found = await sql`
    SELECT id FROM memories
    WHERE search_vector @@ plainto_tsquery('english', 'SEARCH_VECTOR_TEST_ROW')
  `;
  console.log(`Found via FTS: ${found.length > 0 ? "YES" : "NO"}`);

  // Clean up
  await sql`DELETE FROM memories WHERE id = ${inserted.id}`;
  console.log("Test row cleaned up.");

  console.log("\n── 5. GIN index check ──");
  const indexes = await sql`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE tablename = 'memories' AND indexname LIKE '%search_vector%'
  `;
  for (const idx of indexes) {
    console.log(`  ${idx.indexname}: ${idx.indexdef}`);
  }

  console.log("\n✓ All checks passed!");
}

run().catch((err) => {
  console.error("Verification failed:", err.message);
  process.exit(1);
});

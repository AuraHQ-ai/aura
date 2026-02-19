/**
 * Backfill script: re-embed all memories using text-embedding-3-large (3072 dims).
 *
 * Run after deploying the 1536->3072 migration.
 * Idempotent: only processes memories where embedding IS NULL.
 *
 * Usage:
 *   npx tsx scripts/backfill-embeddings.ts
 *
 * Requires DATABASE_URL and OPENAI_API_KEY (or Vercel AI Gateway config).
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { isNull, sql } from "drizzle-orm";
import { memories } from "../src/db/schema.js";
import { embedTexts } from "../src/lib/embeddings.js";

const BATCH_SIZE = 100;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  const client = neon(connectionString);
  const db = drizzle(client);

  // Count memories needing embeddings
  const result = await db.execute(
    sql`SELECT count(*) as total FROM memories WHERE embedding IS NULL`
  );
  const total = Number(result.rows[0].total);

  console.log(`Found ${total} memories without embeddings`);
  if (total === 0) {
    console.log("Nothing to do!");
    return;
  }

  let processed = 0;
  let errors = 0;

  while (true) {
    const batch = await db
      .select({ id: memories.id, content: memories.content })
      .from(memories)
      .where(isNull(memories.embedding))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    console.log(
      `Batch ${Math.floor(processed / BATCH_SIZE) + 1}: ${batch.length} memories`
    );

    try {
      const texts = batch.map((m) => m.content);
      const embeddings = await embedTexts(texts);

      for (let i = 0; i < batch.length; i++) {
        const vectorStr = `[${embeddings[i].join(",")}]`;
        await db.execute(
          sql`UPDATE memories SET embedding = ${vectorStr}::vector WHERE id = ${batch[i].id}`
        );
      }

      processed += batch.length;
      console.log(`  Done: ${processed}/${total}`);
    } catch (err) {
      errors++;
      console.error(`  Error:`, err);
      if (errors > 5) {
        console.error("Too many errors, aborting");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\nComplete: ${processed} memories re-embedded (3072d, text-embedding-3-large)`);
}

main().catch(console.error);

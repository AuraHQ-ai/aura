import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
const envFile = isProd ? ".env.production" : ".env.local";
config({ path: resolve(repoRoot, envFile) });
if (isProd) console.log("Using .env.production (--prod)");

const { db } = await import("../db/client.js");

type ResultRow = Record<string, unknown>;
function extractRows(result: unknown): ResultRow[] {
  return ((result as any).rows ?? result) as ResultRow[];
}

async function main() {
  console.log("=== Memory Reset Script (full) ===\n");

  const [memCount] = extractRows(
    await db.execute(sql`SELECT count(*)::int AS c FROM memories`),
  );
  const [meCount] = extractRows(
    await db.execute(sql`SELECT count(*)::int AS c FROM memory_entities`),
  );
  const [eaCount] = extractRows(
    await db.execute(sql`SELECT count(*)::int AS c FROM entity_aliases`),
  );
  const [eCount] = extractRows(
    await db.execute(sql`SELECT count(*)::int AS c FROM entities`),
  );
  const [uLinked] = extractRows(
    await db.execute(
      sql`SELECT count(*)::int AS c FROM users WHERE entity_id IS NOT NULL`,
    ),
  );

  console.log("Before:");
  console.log(`  memories:              ${memCount.c}`);
  console.log(`  memory_entities:       ${meCount.c}`);
  console.log(`  entity_aliases:        ${eaCount.c}`);
  console.log(`  entities:              ${eCount.c}`);
  console.log(`  users with entity_id:  ${uLinked.c}`);
  console.log();

  // Order matters: respect FK dependencies
  await db.execute(sql`UPDATE users SET entity_id = NULL WHERE entity_id IS NOT NULL`);
  console.log("Set users.entity_id = NULL");

  await db.execute(sql`DELETE FROM memory_entities`);
  console.log("Deleted all memory_entities");

  await db.execute(sql`DELETE FROM entity_aliases`);
  console.log("Deleted all entity_aliases");

  await db.execute(sql`DELETE FROM entities`);
  console.log("Deleted all entities");

  await db.execute(sql`DELETE FROM memories`);
  console.log("Deleted all memories");

  const [memAfter] = extractRows(
    await db.execute(sql`SELECT count(*)::int AS c FROM memories`),
  );
  const [meAfter] = extractRows(
    await db.execute(sql`SELECT count(*)::int AS c FROM memory_entities`),
  );
  const [eaAfter] = extractRows(
    await db.execute(sql`SELECT count(*)::int AS c FROM entity_aliases`),
  );
  const [eAfter] = extractRows(
    await db.execute(sql`SELECT count(*)::int AS c FROM entities`),
  );
  const [uAfter] = extractRows(
    await db.execute(
      sql`SELECT count(*)::int AS c FROM users WHERE entity_id IS NOT NULL`,
    ),
  );

  console.log("\nAfter:");
  console.log(`  memories:              ${memAfter.c}`);
  console.log(`  memory_entities:       ${meAfter.c}`);
  console.log(`  entity_aliases:        ${eaAfter.c}`);
  console.log(`  entities:              ${eAfter.c}`);
  console.log(`  users with entity_id:  ${uAfter.c}`);
  console.log("\nFull memory + entity reset complete.");
  console.log("Run 'pnpx tsx apps/api/src/scripts/backfill-memories.ts' to rebuild from threads.");
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

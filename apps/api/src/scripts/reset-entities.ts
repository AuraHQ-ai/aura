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
  console.log("=== Entity Reset Script ===\n");

  // Count before
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
  console.log(`  memory_entities: ${meCount.c}`);
  console.log(`  entity_aliases:  ${eaCount.c}`);
  console.log(`  entities:        ${eCount.c}`);
  console.log(`  users with entity_id: ${uLinked.c}`);
  console.log();

  // Null out users.entity_id
  await db.execute(sql`UPDATE users SET entity_id = NULL WHERE entity_id IS NOT NULL`);
  console.log("✓ Set users.entity_id = NULL");

  // Truncate in FK order (CASCADE handles memory_entities & entity_aliases)
  await db.execute(sql`TRUNCATE memory_entities`);
  console.log("✓ Truncated memory_entities");

  await db.execute(sql`TRUNCATE entity_aliases`);
  console.log("✓ Truncated entity_aliases");

  await db.execute(sql`TRUNCATE entities CASCADE`);
  console.log("✓ Truncated entities (CASCADE)");

  // Count after
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
  console.log(`  memory_entities: ${meAfter.c}`);
  console.log(`  entity_aliases:  ${eaAfter.c}`);
  console.log(`  entities:        ${eAfter.c}`);
  console.log(`  users with entity_id: ${uAfter.c}`);
  console.log("\n✓ Entity reset complete.");
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

/**
 * Apply the full packages/db/drizzle migration chain to a LOCAL, disposable
 * Postgres database. Test tooling for the workspace-isolation integration
 * test (issue #1393) — this is how the RLS migrations get exercised without
 * ever touching a shared or production database.
 *
 * SAFETY: refuses to run against anything but localhost. Production
 * migrations go through packages/db/src/migrate.ts on deploy, after human
 * approval — never through this script.
 *
 * Usage: DATABASE_URL=postgres://...@localhost:5432/db tsx scripts/apply-migrations-local.ts
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(__dirname, "..", "..", "..", "packages", "db", "drizzle");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const host = new URL(url).hostname;
if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
  console.error(
    `Refusing to apply migrations to non-local host "${host}". ` +
      "This script exists ONLY for disposable local test databases.",
  );
  process.exit(1);
}

const journal = JSON.parse(
  readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8"),
) as { entries: Array<{ tag: string }> };

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  for (const entry of journal.entries) {
    const content = readFileSync(join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf-8");
    // Same statement-splitting contract as packages/db/src/migrate.ts.
    const statements = content
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      try {
        await client.query(stmt);
      } catch (error) {
        console.error(`Migration ${entry.tag} failed on statement:\n${stmt.slice(0, 300)}`);
        throw error;
      }
    }
    console.log(`applied ${entry.tag}`);
  }
  console.log(`All ${journal.entries.length} migrations applied.`);
} finally {
  await client.end();
}

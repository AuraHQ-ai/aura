/**
 * Hash-based migration runner (replaces drizzle-orm/neon-http/migrator).
 *
 * THE BUG THIS FIXES
 * ==================
 * The upstream drizzle migrator uses a high-watermark strategy: it reads the
 * max(created_at) ledger row and applies only journal entries whose `when` is
 * strictly greater than that value.  Any migration merged with a stale `when`
 * (below the running max) is SILENTLY SKIPPED FOREVER — no error, no warning.
 *
 * Prod evidence: three journal entries (0017_amused_kree, 0025_feedback_table,
 * 0074_dashboard_chat_runs_user_message) have no ledger row because their `when`
 * values fall below the current max.  Their schema changes exist in prod (verified),
 * but the ledger never recorded them.
 *
 * THE FIX
 * =======
 * This runner tracks migrations by SHA-256 content hash, not by timestamp.
 * A migration is applied if and only if its hash is absent from the ledger.
 * Ordering never affects whether a migration runs.
 *
 * SELF-HEALING LEGACY BACKFILL
 * ============================
 * Runs before the apply loop.  For journal entries that are missing from the
 * ledger by hash AND whose `when` is <= the ledger's max created_at (the
 * legacy watermark), we insert the ledger row WITHOUT executing the SQL.
 * This covers the three prod cases above: their schema is correct, only the
 * ledger tracking is wrong.  After the first deploy the rows exist and this
 * is a no-op.
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";
import { planMigrations } from "./migrator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** When run via `tsx src/migrate.ts`, __dirname is packages/db/src/ */
const DRIZZLE_DIR = join(__dirname, "..", "drizzle");

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("DATABASE_URL is not set -- skipping migrations");
  process.exit(0);
}

const sql = neon(connectionString);

/**
 * Execute a raw SQL string against the database.
 *
 * Uses the neon client's `query(string, params)` form which takes a raw SQL
 * string without template literal magic.  Safe for migration DDL from our
 * own files (no user input involved).
 */
function exec(sqlStr: string): Promise<unknown> {
  return sql.query(sqlStr, []);
}

console.log("Running database migrations (hash-based runner)...");

try {
  // ── 1. Ensure the drizzle ledger schema + table exist ─────────────────────
  //       Same DDL drizzle's own migrator uses — drop-in compatible.
  await exec("CREATE SCHEMA IF NOT EXISTS drizzle");
  await exec(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id         serial  PRIMARY KEY,
      hash       text    NOT NULL,
      created_at bigint
    )
  `);

  // ── 2. Read journal ────────────────────────────────────────────────────────
  const journal = JSON.parse(
    readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8")
  ) as { entries: Array<{ idx: number; when: number; tag: string }> };

  // ── 3. Compute SHA-256 of each full SQL file ───────────────────────────────
  //       Drizzle hashes the full file: crypto.createHash("sha256").update(content).digest("hex")
  //       We do the same so existing ledger rows continue to match.
  const entriesWithHashes = journal.entries.map(entry => {
    const content = readFileSync(join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf-8");
    const hash = createHash("sha256").update(content).digest("hex");
    return { tag: entry.tag, when: entry.when, hash };
  });

  // ── 4. Load existing ledger state ─────────────────────────────────────────
  const ledgerRows = (await sql`
    SELECT hash, created_at FROM drizzle.__drizzle_migrations
  `) as { hash: string; created_at: string | null }[];
  const existingHashes = new Set(ledgerRows.map(r => r.hash));
  const ledgerWatermark = ledgerRows.reduce((max, r) => {
    const v = r.created_at ? Number(r.created_at) : 0;
    return v > max ? v : max;
  }, 0);

  // ── 5. Plan (pure, testable — see migrator.ts + migrator.test.ts) ─────────
  const plan = planMigrations(entriesWithHashes, existingHashes, ledgerWatermark);

  // ── 6. Execute the plan in journal order ───────────────────────────────────
  let applied = 0;
  let backfilled = 0;

  for (const item of plan) {
    if (item.action === "skip") continue;

    if (item.action === "backfill") {
      // Legacy backfill: this entry was silently skipped by the old watermark
      // logic but its schema already exists in prod.  Record it in the ledger
      // without re-executing the SQL.
      console.warn(
        `[WARN] legacy backfill: ${item.tag} (when=${item.when}) is missing from ` +
          `the ledger but when <= watermark (${ledgerWatermark}). ` +
          `Presumed applied by an earlier in-place-edited migration. ` +
          `Inserting ledger row WITHOUT executing SQL.`
      );
      await sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${item.hash}, ${item.when})
      `;
      backfilled++;
      continue;
    }

    // action === "apply": genuinely new migration
    console.log(`Applying migration: ${item.tag}`);
    const content = readFileSync(join(DRIZZLE_DIR, `${item.tag}.sql`), "utf-8");
    const statements = content
      .split("--> statement-breakpoint")
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const stmt of statements) {
      await exec(stmt);
    }

    await sql`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${item.hash}, ${item.when})
    `;
    applied++;
  }

  // ── 7. Summary ────────────────────────────────────────────────────────────
  const skipped = plan.filter(p => p.action === "skip").length;
  if (backfilled > 0) {
    console.log(
      `Legacy backfill complete: ${backfilled} ledger row(s) inserted without SQL execution.`
    );
  }
  console.log(
    `Migrations complete. Applied=${applied} Backfilled=${backfilled} Skipped=${skipped}`
  );
} catch (error) {
  console.error("Migration failed:", error);
  process.exit(1);
}

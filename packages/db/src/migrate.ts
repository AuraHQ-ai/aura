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
 * LEGACY RECONCILIATION (one-time, closed set)
 * ============================================
 * Flipping to hash-based tracking would try to re-run history that already
 * ran, and `0025_feedback_table.sql` is a bare `CREATE TABLE "feedback"` that
 * would hard-fail the build.  So a CLOSED, hash-pinned list
 * (LEGACY_BACKFILL_HASHES in migrator.ts) records those specific entries in the
 * ledger without executing their SQL.  Ten entries, each verified against the
 * live prod schema on 2026-08-17.  After the first deploy they all match by
 * hash and the list is inert.
 *
 * What this deliberately does NOT do: infer "already applied" from a
 * timestamp.  Backfilling anything whose `when` is below the ledger watermark
 * would reproduce the very bug above — the SQL still never runs, except now a
 * ledger row asserts that it did, which makes the omission invisible.  A new
 * migration missing from the ledger EXECUTES, whatever its timestamp.
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";
import { planMigrations, LEGACY_BACKFILL_HASHES } from "./migrator.js";

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

  // ── 5. Plan (pure, testable — see migrator.ts + migrator.test.ts) ─────────
  //       Timestamps do NOT decide execution.  A migration runs iff its hash is
  //       absent from the ledger and is not in the closed legacy reconciliation
  //       set.  Deciding by `when` would reproduce the very bug this replaces.
  const plan = planMigrations(entriesWithHashes, existingHashes, LEGACY_BACKFILL_HASHES);

  // ── 6. Execute the plan in journal order ───────────────────────────────────
  let applied = 0;
  let backfilled = 0;

  for (const item of plan) {
    if (item.action === "skip") continue;

    if (item.action === "backfill") {
      // Legacy reconciliation: pre-existing history whose schema is already in
      // prod (either silently skipped by the old watermark logic, or applied and
      // then edited in place).  Record it in the ledger without executing SQL.
      console.warn(
        `[WARN] legacy reconciliation: ${item.tag} (when=${item.when}) is missing ` +
          `from the ledger but is in the closed LEGACY_BACKFILL_HASHES set — its ` +
          `schema was verified present in prod on 2026-08-17. ` +
          `Inserting ledger row WITHOUT executing SQL. This should happen exactly once.`
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

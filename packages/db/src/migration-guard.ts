/**
 * Migration guard — pure check logic + CI runner.
 *
 * Exported functions are tested in migration-guard.test.ts.
 * When executed as a script (via `tsx src/migration-guard.ts`), main() reads
 * the git state and runs all checks, exiting non-zero on any failure.
 *
 * Checks performed (on newly-added entries unless noted):
 *   1. out-of-order    — new entry `when` <= max `when` on main (stale branch)
 *   2. duplicate-when  — two new entries share the same `when`
 *   3. missing-sql     — any journal entry (new or existing) has no .sql file
 *   4. orphaned-sql    — a .sql file in drizzle/ has no journal entry
 */

import { execSync } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ── Types ────────────────────────────────────────────────────────────────────

export interface JournalEntry {
  tag: string;
  when: number;
}

export type GuardErrorType =
  | "out-of-order"
  | "duplicate-when"
  | "missing-sql"
  | "orphaned-sql";

export interface GuardError {
  type: GuardErrorType;
  message: string;
}

// ── Pure check logic ─────────────────────────────────────────────────────────

/**
 * Validate migration journal invariants.  No I/O — all inputs pre-loaded.
 *
 * @param mainMaxWhen     max `when` from the main-branch journal (0 if empty)
 * @param mainTags        set of tags already present on main
 * @param prEntries       all journal entries in the PR (full journal)
 * @param sqlFilesOnDisk  tag names (without .sql) of files present in drizzle/
 */
export function checkMigrationGuard(
  mainMaxWhen: number,
  mainTags: Set<string>,
  prEntries: JournalEntry[],
  sqlFilesOnDisk: Set<string>
): GuardError[] {
  const errors: GuardError[] = [];
  const newEntries = prEntries.filter(e => !mainTags.has(e.tag));

  // ── Check 1: out-of-order generation ────────────────────────────────────
  // A new migration whose `when` is <= the main max `when` was generated on a
  // stale branch.  Any watermark-based migrator would silently skip it.
  for (const entry of newEntries) {
    if (entry.when <= mainMaxWhen) {
      errors.push({
        type: "out-of-order",
        message:
          `Migration "${entry.tag}" was generated on a stale branch ` +
          `(when=${entry.when} <= main max when=${mainMaxWhen}). ` +
          `Rebase on main and run \`pnpm db:generate\` again.`,
      });
    }
  }

  // ── Check 2: duplicate when values among new entries ────────────────────
  // Two new migrations with the same timestamp can cause subtle ordering bugs.
  const seenWhen = new Map<number, string>();
  for (const entry of newEntries) {
    const prior = seenWhen.get(entry.when);
    if (prior !== undefined) {
      errors.push({
        type: "duplicate-when",
        message:
          `Entries "${prior}" and "${entry.tag}" both have when=${entry.when}. ` +
          `Rebase and regenerate to get distinct timestamps.`,
      });
    } else {
      seenWhen.set(entry.when, entry.tag);
    }
  }

  // ── Check 3: missing SQL file (all journal entries) ─────────────────────
  for (const entry of prEntries) {
    if (!sqlFilesOnDisk.has(entry.tag)) {
      errors.push({
        type: "missing-sql",
        message: `Journal entry "${entry.tag}" references a missing file: drizzle/${entry.tag}.sql`,
      });
    }
  }

  // ── Check 4: orphaned SQL file (all files in drizzle/) ──────────────────
  const journalTags = new Set(prEntries.map(e => e.tag));
  for (const tag of sqlFilesOnDisk) {
    if (!journalTags.has(tag)) {
      errors.push({
        type: "orphaned-sql",
        message: `SQL file drizzle/${tag}.sql has no corresponding journal entry.`,
      });
    }
  }

  return errors;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** packages/db/drizzle/ */
const DRIZZLE_DIR = join(__dirname, "..", "drizzle");
/** repo root (packages/db/src/ → up three levels) */
const REPO_ROOT = join(__dirname, "..", "..", "..");

async function main() {
  // 1. Get main-branch journal via git
  let mainJournalText = "";
  const refCandidates = ["origin/main", "origin/master", "main", "master"];
  let resolved = false;

  for (const ref of refCandidates) {
    try {
      mainJournalText = execSync(
        `git show ${ref}:packages/db/drizzle/meta/_journal.json`,
        { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      resolved = true;
      break;
    } catch {
      // Try next candidate
    }
  }

  if (!resolved) {
    console.error(
      "Migration guard: could not read main-branch journal.\n" +
        "Run: git fetch origin main"
    );
    process.exit(1);
  }

  const mainJournal = JSON.parse(mainJournalText) as {
    entries: JournalEntry[];
  };
  const mainMaxWhen = mainJournal.entries.reduce(
    (max, e) => Math.max(max, e.when),
    0
  );
  const mainTags = new Set(mainJournal.entries.map(e => e.tag));

  // 2. Get PR journal from disk
  const prJournalText = readFileSync(
    join(DRIZZLE_DIR, "meta", "_journal.json"),
    "utf-8"
  );
  const prJournal = JSON.parse(prJournalText) as { entries: JournalEntry[] };

  // 3. Collect SQL files in drizzle/
  const sqlFilesOnDisk = new Set(
    readdirSync(DRIZZLE_DIR)
      .filter(f => f.endsWith(".sql"))
      .map(f => f.replace(/\.sql$/, ""))
  );

  // 4. Run checks
  const errors = checkMigrationGuard(
    mainMaxWhen,
    mainTags,
    prJournal.entries,
    sqlFilesOnDisk
  );

  if (errors.length === 0) {
    console.log("Migration guard: all checks passed.");
    process.exit(0);
  }

  console.error("Migration guard FAILED:");
  for (const err of errors) {
    console.error(`  [${err.type}] ${err.message}`);
  }
  console.error(
    "\nTo fix out-of-order migrations: rebase on main and regenerate with `pnpm db:generate`."
  );
  process.exit(1);
}

// Run when executed directly (not when imported by vitest or other modules)
if (process.argv[1]?.includes("migration-guard")) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

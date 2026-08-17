/**
 * Pure migration planning logic — no I/O, no DB, fully testable.
 *
 * The runner (migrate.ts) calls planMigrations() after loading the journal
 * and ledger state.  Tests call it directly with synthetic data.
 */

export interface JournalEntry {
  /** Unique tag for the migration (e.g. "0017_amused_kree") */
  tag: string;
  /** Unix timestamp in milliseconds when the migration was generated */
  when: number;
}

export interface JournalEntryWithHash extends JournalEntry {
  /** SHA-256 of the full .sql file contents */
  hash: string;
}

export type MigrationAction = "apply" | "backfill" | "skip";

export interface MigrationPlan extends JournalEntryWithHash {
  action: MigrationAction;
}

/**
 * Decide what to do with each journal entry.
 *
 * Rules (in priority order):
 *   1. Hash already in ledger → "skip"  (idempotent)
 *   2. Hash absent AND when <= ledgerWatermark → "backfill"
 *      The migration was silently skipped by the old high-watermark logic but
 *      its schema already exists.  Insert the ledger row without re-executing.
 *   3. Hash absent AND when > ledgerWatermark → "apply"
 *      Genuinely new migration — execute and record.
 *
 * Ordering does NOT affect whether a migration runs; only the hash does.
 *
 * @param entries          Journal entries with pre-computed hashes, in journal order
 * @param existingHashes   Set of hashes currently in drizzle.__drizzle_migrations
 * @param ledgerWatermark  max(created_at) from the ledger; 0 if the ledger is empty
 */
export function planMigrations(
  entries: JournalEntryWithHash[],
  existingHashes: Set<string>,
  ledgerWatermark: number
): MigrationPlan[] {
  return entries.map(entry => {
    if (existingHashes.has(entry.hash)) {
      return { ...entry, action: "skip" as const };
    }
    if (entry.when <= ledgerWatermark) {
      return { ...entry, action: "backfill" as const };
    }
    return { ...entry, action: "apply" as const };
  });
}

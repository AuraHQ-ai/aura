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
 * Known-legacy hashes: migrations whose SQL demonstrably already ran against
 * production but whose ledger row is absent or stale.  Measured on 2026-08-17
 * against the live ledger (79 rows / 82 journal entries).
 *
 * Two distinct causes, both verified:
 *   (a) Silently skipped by the old high-watermark migrator (`when` below the
 *       running max).  Their schema objects were verified present in prod:
 *       0017 → emails_raw columns, 0025 → feedback table + unique index,
 *       0074 → dashboard_chat_runs.user_message.
 *   (b) Applied normally, then the .sql file was edited in place afterwards,
 *       so the file hash no longer matches the ledger row.  Each of these has
 *       an orphan ledger row at the identical `created_at`.
 *
 * This list is CLOSED.  It exists only to reconcile history that predates the
 * hash-based runner.  Once these rows land, every entry here plans as "skip"
 * and the list is inert.  DO NOT ADD TO IT to work around a failing migration:
 * a new migration that is missing from the ledger must EXECUTE, not be marked
 * as applied.  See planMigrations().
 */
export const LEGACY_BACKFILL_HASHES: ReadonlyMap<string, string> = new Map([
  // (b) edited in place after being applied — orphan ledger row at same created_at
  ["2edff771f24bb97d11ef9d480ef0f8c2cab77fb5c4bd3b5eda76551f68245bca", "0006_volatile_cannonball"],
  ["a349ec370a3216dee589cd19ef1055cd2b98c25e1d5ff95bbb6b67741d73b803", "0016_add_oauth_tokens"],
  ["0a4301ad0ae605a9f3f1d99c2826aac9f4a5393f50cf5387841784b9b0961f70", "0027_api_credentials"],
  ["c0a582517466882bb94712043ae880b1714dfc154ce777c3ef93aa7aea74e7f8", "0028_job_credential_ids"],
  ["767aabdfeb61dd16f6969020c426e72f4d3b2b5466231f4afebedad8f25b8cef", "0031_hybrid_memory_search"],
  ["0c426cfbc24a40672a3ce2ad35b73746c02b2a6d6ecd87fb5ddce4bc808a18c1", "0049_remove_governance_tables"],
  ["1197a8ff4fc3a31c33fc1f47e5bb8e9762f0450649ae291e7b69ffcaa0fae526", "0054_echo_loop_prevention"],
  // (a) silently skipped by the watermark bug — schema verified present in prod
  ["daab31de8de4e72ccb327d8f540cf821341577580466daea694212a27977d5e0", "0017_amused_kree"],
  ["3dac0cbc18a14f60af945ff92efe78319f9d0a30068bb8514e76d4464379fff0", "0025_feedback_table"],
  ["5856e3d56893bddb6cadcb4808121861d171c3bc5ebb8f0b3d9a60debcf291d9", "0074_dashboard_chat_runs_user_message"],
]);

/**
 * Decide what to do with each journal entry.
 *
 * Rules (in priority order):
 *   1. Hash already in ledger → "skip"  (idempotent)
 *   2. Hash in the closed LEGACY_BACKFILL_HASHES set → "backfill"
 *      Historical reconciliation only: insert the ledger row, do NOT execute.
 *   3. Otherwise → "apply"
 *      Execute and record, REGARDLESS of `when`.
 *
 * Rule 3 is the whole point.  An out-of-order migration (stale branch merged
 * after a newer one) has a `when` below the ledger max, and the old migrator
 * silently skipped it.  Marking it "backfill" on the basis of its timestamp
 * would reproduce that bug with extra steps: the SQL still never runs, and now
 * a ledger row lies about it, making the omission undetectable.  Timestamps do
 * not decide execution here — only hashes do.
 *
 * @param entries          Journal entries with pre-computed hashes, in journal order
 * @param existingHashes   Set of hashes currently in drizzle.__drizzle_migrations
 * @param legacyHashes     Closed set of pre-existing hashes to record without executing
 */
export function planMigrations(
  entries: JournalEntryWithHash[],
  existingHashes: Set<string>,
  legacyHashes: ReadonlySet<string> | ReadonlyMap<string, string> = LEGACY_BACKFILL_HASHES
): MigrationPlan[] {
  return entries.map(entry => {
    if (existingHashes.has(entry.hash)) {
      return { ...entry, action: "skip" as const };
    }
    if (legacyHashes.has(entry.hash)) {
      return { ...entry, action: "backfill" as const };
    }
    return { ...entry, action: "apply" as const };
  });
}

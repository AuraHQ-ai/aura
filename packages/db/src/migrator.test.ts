import { describe, it, expect } from "vitest";
import { planMigrations } from "./migrator.js";
import type { JournalEntryWithHash, MigrationPlan } from "./migrator.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function e(tag: string, when: number, hash: string): JournalEntryWithHash {
  return { tag, when, hash };
}

function actions(plan: MigrationPlan[]) {
  return plan.map(p => `${p.tag}:${p.action}`);
}

// Current prod watermark: max(when) from the journal = 0081's when
const PROD_WATERMARK = 1787158001000;

// ── planMigrations tests ──────────────────────────────────────────────────────

describe("planMigrations", () => {
  // ── Basic rules ────────────────────────────────────────────────────────────

  it("skips a migration whose hash is already in the ledger", () => {
    const plan = planMigrations(
      [e("0000_init", 1771062880226, "known_hash")],
      new Set(["known_hash"]),
      PROD_WATERMARK
    );
    expect(plan[0].action).toBe("skip");
  });

  it("applies a new migration above the watermark", () => {
    const plan = planMigrations(
      [e("0082_new_table", 1800000000000, "new_hash")],
      new Set(),
      PROD_WATERMARK
    );
    expect(plan[0].action).toBe("apply");
  });

  it("backfills a migration below the watermark whose hash is absent", () => {
    const plan = planMigrations(
      [e("NNNN_stale", 1750000000000, "stale_hash")],
      new Set(),
      PROD_WATERMARK
    );
    expect(plan[0].action).toBe("backfill");
  });

  it("backfills a migration exactly at the watermark boundary", () => {
    // when <= watermark → backfill (not apply)
    const plan = planMigrations(
      [e("NNNN_boundary", PROD_WATERMARK, "boundary_hash")],
      new Set(),
      PROD_WATERMARK
    );
    expect(plan[0].action).toBe("backfill");
  });

  // ── The ordering bug ───────────────────────────────────────────────────────

  it("handles the ordering bug: out-of-order migration is backfilled, not silently skipped", () => {
    // Old watermark-based migrator: sees when <= max → skips forever (bug).
    // New hash-based migrator: hash absent AND when <= watermark → backfill.
    // The migration gets a ledger row without re-executing; subsequent runs skip.
    const plan = planMigrations(
      [e("NNNN_out_of_order", 1750000000000, "missing_hash")],
      new Set(),
      PROD_WATERMARK
    );
    expect(plan[0].action).toBe("backfill");
    // Crucially, NOT "skip" (that would require the hash to be present)
    expect(plan[0].action).not.toBe("skip");
  });

  // ── Real prod cases ────────────────────────────────────────────────────────

  it("backfills 0017_amused_kree (prod case: below watermark, hash absent)", () => {
    const plan = planMigrations(
      [e("0017_amused_kree", 1771757715594, "hash_0017")],
      new Set(), // not in ledger
      PROD_WATERMARK
    );
    expect(plan[0].action).toBe("backfill");
  });

  it("backfills 0025_feedback_table (prod case: below watermark, hash absent)", () => {
    // 0025 uses bare CREATE TABLE (no IF NOT EXISTS) — re-running would hard-fail.
    // Backfill ensures it is never re-executed.
    const plan = planMigrations(
      [e("0025_feedback_table", 1772600000000, "hash_0025")],
      new Set(),
      PROD_WATERMARK
    );
    expect(plan[0].action).toBe("backfill");
  });

  it("backfills 0074_dashboard_chat_runs_user_message (prod case: below watermark, hash absent)", () => {
    const plan = planMigrations(
      [e("0074_dashboard_chat_runs_user_message", 1781080113835, "hash_0074")],
      new Set(),
      PROD_WATERMARK
    );
    expect(plan[0].action).toBe("backfill");
  });

  it("backfills all three prod missing entries together", () => {
    const prodMissing = [
      e("0017_amused_kree", 1771757715594, "hash_0017"),
      e("0025_feedback_table", 1772600000000, "hash_0025"),
      e("0074_dashboard_chat_runs_user_message", 1781080113835, "hash_0074"),
    ];
    const plan = planMigrations(prodMissing, new Set(), PROD_WATERMARK);
    expect(plan.every(p => p.action === "backfill")).toBe(true);
  });

  // ── Full no-op (all hashes present) ────────────────────────────────────────

  it("skips everything when all hashes are already in the ledger", () => {
    const entries = [
      e("0000_init", 1771062880226, "h0"),
      e("0001_next", 1771103243060, "h1"),
      e("0082_latest", 1800000000000, "h2"),
    ];
    const existingHashes = new Set(["h0", "h1", "h2"]);
    const plan = planMigrations(entries, existingHashes, PROD_WATERMARK);
    expect(plan.every(p => p.action === "skip")).toBe(true);
  });

  // ── Fresh DB (empty ledger) ────────────────────────────────────────────────

  it("applies all entries on a fresh DB (watermark=0, empty ledger)", () => {
    const entries = [
      e("0000_init", 1771062880226, "h0"),
      e("0001_next", 1771103243060, "h1"),
    ];
    const plan = planMigrations(entries, new Set(), 0);
    // watermark=0 means every entry's when > 0, so all get "apply"
    expect(plan.every(p => p.action === "apply")).toBe(true);
  });

  // ── Mixed scenario ────────────────────────────────────────────────────────

  it("handles mixed skip / backfill / apply in one plan", () => {
    const entries = [
      e("already_applied", 1771000000000, "in_ledger"), // skip
      e("skipped_by_old", 1771000000001, "missing_old"), // backfill (below watermark)
      e("new_migration", 1800000000000, "new_hash"), // apply (above watermark)
    ];
    const plan = planMigrations(
      entries,
      new Set(["in_ledger"]),
      PROD_WATERMARK
    );
    expect(actions(plan)).toEqual([
      "already_applied:skip",
      "skipped_by_old:backfill",
      "new_migration:apply",
    ]);
  });

  // ── Ordering invariant ────────────────────────────────────────────────────

  it("preserves journal entry order in the output plan", () => {
    const entries = [
      e("tag_c", 1771000000003, "hc"),
      e("tag_a", 1771000000001, "ha"),
      e("tag_b", 1771000000002, "hb"),
    ];
    const plan = planMigrations(entries, new Set(), 0);
    expect(plan.map(p => p.tag)).toEqual(["tag_c", "tag_a", "tag_b"]);
  });
});

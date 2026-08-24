import { describe, it, expect } from "vitest";
import { planMigrations, LEGACY_BACKFILL_HASHES } from "./migrator.js";
import type { JournalEntryWithHash, MigrationPlan } from "./migrator.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function e(tag: string, when: number, hash: string): JournalEntryWithHash {
  return { tag, when, hash };
}

function actions(plan: MigrationPlan[]) {
  return plan.map(p => `${p.tag}:${p.action}`);
}

/** Real prod ledger watermark on 2026-08-17 (0081's `when`). */
const PROD_WATERMARK = 1787158001000;

/** Real hash of 0025_feedback_table.sql — bare CREATE TABLE, must never re-run. */
const HASH_0025 = "3dac0cbc18a14f60af945ff92efe78319f9d0a30068bb8514e76d4464379fff0";
/** Real hash of 0017_amused_kree.sql. */
const HASH_0017 = "daab31de8de4e72ccb327d8f540cf821341577580466daea694212a27977d5e0";
/** Real hash of 0074_dashboard_chat_runs_user_message.sql. */
const HASH_0074 = "5856e3d56893bddb6cadcb4808121861d171c3bc5ebb8f0b3d9a60debcf291d9";

// ── planMigrations ───────────────────────────────────────────────────────────

describe("planMigrations", () => {
  it("skips a migration whose hash is already in the ledger", () => {
    const plan = planMigrations([e("0001_a", 1000, "hash_a")], new Set(["hash_a"]));
    expect(plan[0].action).toBe("skip");
  });

  it("applies a new migration whose hash is absent", () => {
    const plan = planMigrations([e("0090_new", PROD_WATERMARK + 5000, "hash_new")], new Set());
    expect(plan[0].action).toBe("apply");
  });

  it("applies all entries on a fresh DB", () => {
    const plan = planMigrations(
      [e("0001_a", 1000, "h1"), e("0002_b", 2000, "h2"), e("0003_c", 3000, "h3")],
      new Set()
    );
    expect(actions(plan)).toEqual(["0001_a:apply", "0002_b:apply", "0003_c:apply"]);
  });

  it("skips everything when all hashes are present", () => {
    const entries = [e("0001_a", 1000, "h1"), e("0002_b", 2000, "h2")];
    const plan = planMigrations(entries, new Set(["h1", "h2"]));
    expect(actions(plan)).toEqual(["0001_a:skip", "0002_b:skip"]);
  });

  it("preserves journal order in the output plan", () => {
    const entries = [e("0003_c", 3000, "h3"), e("0001_a", 1000, "h1"), e("0002_b", 2000, "h2")];
    const plan = planMigrations(entries, new Set());
    expect(plan.map(p => p.tag)).toEqual(["0003_c", "0001_a", "0002_b"]);
  });

  // ── The regression this whole PR exists to prevent ─────────────────────────

  it("APPLIES an out-of-order migration instead of skipping or backfilling it", () => {
    // The old watermark migrator skipped this forever. A timestamp-based
    // backfill would be just as wrong: the SQL never runs, but a ledger row
    // claims it did. It must EXECUTE.
    const plan = planMigrations(
      [e("0079_stale_branch", PROD_WATERMARK - 5_000_000, "hash_stale")],
      new Set()
    );
    expect(plan[0].action).toBe("apply");
  });

  it("does not treat a low `when` as evidence of prior application", () => {
    // Ancient timestamp, unknown hash, empty ledger → still apply.
    const plan = planMigrations([e("0091_ancient_ts", 1, "hash_unknown")], new Set());
    expect(plan[0].action).toBe("apply");
  });

  it("applies a new migration even when the ledger contains far newer rows", () => {
    const plan = planMigrations(
      [e("0092_late_merge", PROD_WATERMARK - 1, "hash_late")],
      new Set(["some_much_newer_hash"])
    );
    expect(plan[0].action).toBe("apply");
  });

  // ── Legacy reconciliation (closed set) ────────────────────────────────────

  it("backfills only hashes in the closed legacy set", () => {
    const plan = planMigrations(
      [
        e("0017_amused_kree", 1771757715594, HASH_0017),
        e("0025_feedback_table", 1772600000000, HASH_0025),
        e("0074_dashboard_chat_runs_user_message", 1781080113835, HASH_0074),
        e("0093_genuinely_new", 1771000000000, "hash_not_in_legacy_set"),
      ],
      new Set()
    );
    expect(actions(plan)).toEqual([
      "0017_amused_kree:backfill",
      "0025_feedback_table:backfill",
      "0074_dashboard_chat_runs_user_message:backfill",
      // same era of timestamps, but not a known-legacy hash → must execute
      "0093_genuinely_new:apply",
    ]);
  });

  it("never re-executes 0025_feedback_table (bare CREATE TABLE would hard-fail)", () => {
    const plan = planMigrations([e("0025_feedback_table", 1772600000000, HASH_0025)], new Set());
    expect(plan[0].action).not.toBe("apply");
    expect(plan[0].action).toBe("backfill");
  });

  it("prefers skip over backfill once the legacy row exists (idempotent second deploy)", () => {
    const plan = planMigrations(
      [e("0025_feedback_table", 1772600000000, HASH_0025)],
      new Set([HASH_0025])
    );
    expect(plan[0].action).toBe("skip");
  });

  it("legacy set covers all 10 measured prod discrepancies and nothing else", () => {
    expect(LEGACY_BACKFILL_HASHES.size).toBe(10);
    expect(LEGACY_BACKFILL_HASHES.has(HASH_0017)).toBe(true);
    expect(LEGACY_BACKFILL_HASHES.has(HASH_0025)).toBe(true);
    expect(LEGACY_BACKFILL_HASHES.has(HASH_0074)).toBe(true);
    expect(LEGACY_BACKFILL_HASHES.has("hash_that_does_not_exist")).toBe(false);
  });

  it("handles mixed skip / backfill / apply in one plan", () => {
    const plan = planMigrations(
      [
        e("0001_done", 1000, "h_done"),
        e("0025_feedback_table", 1772600000000, HASH_0025),
        e("0094_new", PROD_WATERMARK + 1000, "h_new"),
      ],
      new Set(["h_done"])
    );
    expect(actions(plan)).toEqual([
      "0001_done:skip",
      "0025_feedback_table:backfill",
      "0094_new:apply",
    ]);
  });

  it("accepts an injected legacy set for testing without touching the prod list", () => {
    const plan = planMigrations(
      [e("0095_x", 500, "h_x")],
      new Set(),
      new Set(["h_x"])
    );
    expect(plan[0].action).toBe("backfill");
  });
});

import { describe, it, expect } from "vitest";
import { checkMigrationGuard } from "./migration-guard.js";
import type { JournalEntry } from "./migration-guard.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function e(tag: string, when: number): JournalEntry {
  return { tag, when };
}

// Simulate a realistic main-branch state
const MAIN_MAX_WHEN = 1787158001000; // 0081's when
const MAIN_TAGS = new Set([
  "0000_zippy_robin_chapel",
  "0079_medium_model_category",
  "0080_detached_commands_job_link",
  "0081_drop_model_catalog_selections",
]);

// ── checkMigrationGuard tests ────────────────────────────────────────────────

describe("checkMigrationGuard", () => {
  // ── Happy path ────────────────────────────────────────────────────────────

  it("passes with no new entries (PR only has pre-existing migrations)", () => {
    const prEntries = [
      e("0000_zippy_robin_chapel", 1771062880226),
      e("0081_drop_model_catalog_selections", 1787158001000),
    ];
    const sqlFiles = new Set([
      "0000_zippy_robin_chapel",
      "0081_drop_model_catalog_selections",
    ]);
    const errors = checkMigrationGuard(MAIN_MAX_WHEN, MAIN_TAGS, prEntries, sqlFiles);
    expect(errors).toHaveLength(0);
  });

  it("passes with a properly ordered new migration", () => {
    const prEntries = [
      e("0081_drop_model_catalog_selections", 1787158001000),
      e("0082_new_feature", 1800000000000), // clearly above main max
    ];
    const sqlFiles = new Set([
      "0081_drop_model_catalog_selections",
      "0082_new_feature",
    ]);
    const errors = checkMigrationGuard(MAIN_MAX_WHEN, MAIN_TAGS, prEntries, sqlFiles);
    expect(errors).toHaveLength(0);
  });

  // ── Check 1: out-of-order ─────────────────────────────────────────────────

  it("detects a new entry with when <= main max when (out-of-order generation)", () => {
    const prEntries = [
      e("0081_drop_model_catalog_selections", 1787158001000),
      e("0082_stale", 1780000000000), // stale branch: when < main max
    ];
    const sqlFiles = new Set([
      "0081_drop_model_catalog_selections",
      "0082_stale",
    ]);
    const errors = checkMigrationGuard(MAIN_MAX_WHEN, MAIN_TAGS, prEntries, sqlFiles);
    expect(errors.filter(e => e.type === "out-of-order")).toHaveLength(1);
    expect(errors[0].message).toContain("0082_stale");
    expect(errors[0].message).toContain("Rebase");
  });

  it("detects a new entry with when exactly equal to main max when", () => {
    const prEntries = [
      e("0081_drop_model_catalog_selections", 1787158001000),
      e("0082_collision", MAIN_MAX_WHEN), // equal, not greater
    ];
    const sqlFiles = new Set([
      "0081_drop_model_catalog_selections",
      "0082_collision",
    ]);
    const errors = checkMigrationGuard(MAIN_MAX_WHEN, MAIN_TAGS, prEntries, sqlFiles);
    expect(errors.some(e => e.type === "out-of-order")).toBe(true);
  });

  it("does NOT flag pre-existing (main) entries as out-of-order", () => {
    // All entries are already on main — should be clean
    const prEntries = [e("0000_zippy_robin_chapel", 1771062880226)];
    const sqlFiles = new Set(["0000_zippy_robin_chapel"]);
    const errors = checkMigrationGuard(MAIN_MAX_WHEN, MAIN_TAGS, prEntries, sqlFiles);
    expect(errors.filter(e => e.type === "out-of-order")).toHaveLength(0);
  });

  // ── Check 2: duplicate when ───────────────────────────────────────────────

  it("detects duplicate when values among newly added entries", () => {
    const sameWhen = 1800000000001;
    const prEntries = [
      e("0081_drop_model_catalog_selections", 1787158001000),
      e("0082_first", sameWhen),
      e("0083_second", sameWhen), // collision
    ];
    const sqlFiles = new Set([
      "0081_drop_model_catalog_selections",
      "0082_first",
      "0083_second",
    ]);
    const errors = checkMigrationGuard(MAIN_MAX_WHEN, MAIN_TAGS, prEntries, sqlFiles);
    expect(errors.filter(e => e.type === "duplicate-when")).toHaveLength(1);
    expect(errors.find(e => e.type === "duplicate-when")?.message).toContain(
      "0083_second"
    );
  });

  it("does NOT flag duplicate when on pre-existing entries already on main", () => {
    // The real journal has 0026 and 0027 both at 1772880000000 (and 0031 too).
    // These are on main — the guard must not complain about them.
    const mainTagsWithDupes = new Set([
      "0026_resources_table",
      "0027_api_credentials",
      "0031_hybrid_memory_search",
    ]);
    const prEntries = [
      e("0026_resources_table", 1772880000000),
      e("0027_api_credentials", 1772880000000),
      e("0031_hybrid_memory_search", 1772880000000),
    ];
    const sqlFiles = new Set([
      "0026_resources_table",
      "0027_api_credentials",
      "0031_hybrid_memory_search",
    ]);
    const errors = checkMigrationGuard(
      1787158001000,
      mainTagsWithDupes,
      prEntries,
      sqlFiles
    );
    expect(errors.filter(e => e.type === "duplicate-when")).toHaveLength(0);
  });

  // ── Check 3: missing SQL file ─────────────────────────────────────────────

  it("detects a journal entry with no corresponding SQL file", () => {
    const prEntries = [e("0082_no_sql", 1800000000000)];
    const sqlFiles = new Set<string>(); // file doesn't exist
    const errors = checkMigrationGuard(MAIN_MAX_WHEN, MAIN_TAGS, prEntries, sqlFiles);
    expect(errors.some(e => e.type === "missing-sql")).toBe(true);
    expect(errors.find(e => e.type === "missing-sql")?.message).toContain(
      "0082_no_sql"
    );
  });

  it("flags missing SQL for existing (main) entries too", () => {
    // If someone deleted a SQL file, it should be caught regardless of age
    const prEntries = [e("0000_zippy_robin_chapel", 1771062880226)];
    const sqlFiles = new Set<string>(); // file deleted
    const errors = checkMigrationGuard(MAIN_MAX_WHEN, MAIN_TAGS, prEntries, sqlFiles);
    expect(errors.some(e => e.type === "missing-sql")).toBe(true);
  });

  // ── Check 4: orphaned SQL file ────────────────────────────────────────────

  it("detects an SQL file with no corresponding journal entry", () => {
    const prEntries: JournalEntry[] = []; // empty journal
    const sqlFiles = new Set(["0082_orphan"]);
    const errors = checkMigrationGuard(MAIN_MAX_WHEN, MAIN_TAGS, prEntries, sqlFiles);
    expect(errors.some(e => e.type === "orphaned-sql")).toBe(true);
    expect(errors.find(e => e.type === "orphaned-sql")?.message).toContain(
      "0082_orphan"
    );
  });

  // ── Multiple errors at once ────────────────────────────────────────────────

  it("reports multiple error types simultaneously", () => {
    const prEntries = [
      e("0081_drop_model_catalog_selections", 1787158001000), // existing, ok
      e("0082_stale", 1780000000000), // out-of-order (below main max)
      e("0083_no_file", 1800000000001), // missing SQL file
    ];
    // 0082_stale and 0083_no_file are present as SQL; 0084_orphan is orphaned
    const sqlFiles = new Set([
      "0081_drop_model_catalog_selections",
      "0082_stale",
      "0084_orphan", // no journal entry
      // 0083_no_file intentionally absent
    ]);
    const errors = checkMigrationGuard(MAIN_MAX_WHEN, MAIN_TAGS, prEntries, sqlFiles);
    const types = new Set(errors.map(e => e.type));
    expect(types.has("out-of-order")).toBe(true);
    expect(types.has("missing-sql")).toBe(true);
    expect(types.has("orphaned-sql")).toBe(true);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("handles empty main and empty PR gracefully", () => {
    const errors = checkMigrationGuard(0, new Set(), [], new Set());
    expect(errors).toHaveLength(0);
  });

  it("handles empty main with new entries that all have fresh timestamps", () => {
    const errors = checkMigrationGuard(
      0,
      new Set(),
      [e("0000_init", 1771062880226)],
      new Set(["0000_init"])
    );
    // when=1771062880226 > 0 (main max when), so no out-of-order
    expect(errors.filter(e => e.type === "out-of-order")).toHaveLength(0);
  });
});

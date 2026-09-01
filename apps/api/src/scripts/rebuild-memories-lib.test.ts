import { describe, it, expect } from "vitest";
import {
  parseRebuildArgs,
  diffSnapshots,
  computeAppliedChanges,
  formatDiffSummary,
  describeScope,
  DEFAULT_MAX_THREADS,
  DEFAULT_CONCURRENCY,
  type MemorySnapshotRow,
  type MemoryFingerprint,
} from "./rebuild-memories-lib.js";

function row(overrides: Partial<MemorySnapshotRow> & { content: string }): MemorySnapshotRow {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    type: "fact",
    status: "current",
    importance: 50,
    relatedUserIds: ["U123"],
    sourceChannelId: "C123",
    sourceThreadTs: "1000.0001",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("parseRebuildArgs", () => {
  it("rejects a run with no scope (no accidental full-corpus rebuilds)", () => {
    const result = parseRebuildArgs([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/scope is required/i);
  });

  it("accepts a single-user scope and defaults to dry run", () => {
    const result = parseRebuildArgs(["--user=U0123ABC"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.scope.user).toBe("U0123ABC");
      expect(result.args.apply).toBe(false);
      expect(result.args.maxThreads).toBe(DEFAULT_MAX_THREADS);
      expect(result.args.concurrency).toBe(DEFAULT_CONCURRENCY);
      expect(result.args.workspaceId).toBe("default");
    }
  });

  it("accepts channel and date-range scopes", () => {
    const result = parseRebuildArgs(["--channel=C0123ABC", "--since=2026-01-01", "--until=2026-02-01"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.scope.channel).toBe("C0123ABC");
      expect(result.args.scope.since).toBe("2026-01-01");
      expect(result.args.scope.until).toBe("2026-02-01");
    }
  });

  it("rejects malformed scope values", () => {
    expect(parseRebuildArgs(["--user=joan"]).ok).toBe(false);
    expect(parseRebuildArgs(["--channel=general"]).ok).toBe(false);
    expect(parseRebuildArgs(["--since=January 1"]).ok).toBe(false);
    expect(parseRebuildArgs(["--since=2026-02-01", "--until=2026-01-01"]).ok).toBe(false);
  });

  it("rejects --apply without the confirmation token", () => {
    const noConfirm = parseRebuildArgs(["--user=U0123ABC", "--apply"]);
    expect(noConfirm.ok).toBe(false);
    if (!noConfirm.ok) expect(noConfirm.error).toMatch(/--confirm=REBUILD/);

    const wrongConfirm = parseRebuildArgs(["--user=U0123ABC", "--apply", "--confirm=yes"]);
    expect(wrongConfirm.ok).toBe(false);

    const confirmed = parseRebuildArgs(["--user=U0123ABC", "--apply", "--confirm=REBUILD"]);
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) expect(confirmed.args.apply).toBe(true);
  });

  it("rejects --apply combined with --dry-run", () => {
    const result = parseRebuildArgs(["--user=U0123ABC", "--apply", "--confirm=REBUILD", "--dry-run"]);
    expect(result.ok).toBe(false);
  });

  it("enforces a finite positive per-run cap", () => {
    expect(parseRebuildArgs(["--user=U0123ABC", "--max-threads=0"]).ok).toBe(false);
    expect(parseRebuildArgs(["--user=U0123ABC", "--max-threads=-5"]).ok).toBe(false);
    expect(parseRebuildArgs(["--user=U0123ABC", "--max-threads=abc"]).ok).toBe(false);
    const ok = parseRebuildArgs(["--user=U0123ABC", "--max-threads=250"]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.args.maxThreads).toBe(250);
  });

  it("bounds concurrency to protect LLM spend", () => {
    expect(parseRebuildArgs(["--user=U0123ABC", "--concurrency=50"]).ok).toBe(false);
    expect(parseRebuildArgs(["--user=U0123ABC", "--concurrency=0"]).ok).toBe(false);
  });

  it("refuses sandbox/bench workspaces as targets", () => {
    expect(parseRebuildArgs(["--user=U0123ABC", "--workspace=rebuild-x"]).ok).toBe(false);
    expect(parseRebuildArgs(["--user=U0123ABC", "--workspace=bench-x"]).ok).toBe(false);
  });
});

describe("diffSnapshots", () => {
  it("reports added, removed, and unchanged memories by normalized content", () => {
    const before = [
      row({ content: "Joan prefers bullet points" }),
      row({ content: "The team uses Postgres", type: "decision" }),
      row({ content: "Old noise memory" }),
    ];
    const after = [
      row({ content: "joan   prefers bullet points" }), // same after normalization
      row({ content: "Vadim owns growth marketing" }),
    ];

    const diff = diffSnapshots(before, after);
    expect(diff.unchanged).toBe(1);
    expect(diff.added.map((m) => m.content)).toEqual(["Vadim owns growth marketing"]);
    expect(diff.removed.map((m) => m.content).sort()).toEqual([
      "Old noise memory",
      "The team uses Postgres",
    ]);
    expect(diff.typeDistributionBefore).toEqual({ fact: 2, decision: 1 });
    expect(diff.typeDistributionAfter).toEqual({ fact: 2 });
  });

  it("formats a readable summary", () => {
    const diff = diffSnapshots([row({ content: "a" })], [row({ content: "b" })]);
    const summary = formatDiffSummary(diff);
    expect(summary).toContain("Memories added:   1");
    expect(summary).toContain("Memories removed: 1");
    expect(summary).toContain("fact: 1 -> 1");
  });
});

describe("computeAppliedChanges", () => {
  const fp = (id: string, status: string, contentHash: string): MemoryFingerprint => ({
    id,
    status,
    contentHash,
  });

  it("classifies added, deleted, and updated rows without relying on timestamps", () => {
    // Replayed memories carry HISTORICAL timestamps (extractor createdAt
    // override), so classification must work purely off id/status/content.
    const before = [
      fp("m1", "current", "aaa"), // will be archived
      fp("m2", "current", "bbb"), // will be superseded
      fp("m3", "current", "ccc"), // content will change
      fp("m4", "disputed", "ddd"), // untouched
      fp("m5", "archived", "eee"), // already dead — stays dead, not counted
    ];
    const after = [
      fp("m1", "archived", "aaa"),
      fp("m2", "superseded", "bbb"),
      fp("m3", "current", "ccc2"),
      fp("m4", "disputed", "ddd"),
      fp("m5", "archived", "eee"),
      fp("m6", "current", "fff"), // brand new
    ];

    const changes = computeAppliedChanges(before, after);
    expect(changes.addedIds).toEqual(["m6"]);
    expect(changes.deletedIds.sort()).toEqual(["m1", "m2"]);
    expect(changes.updatedIds).toEqual(["m3"]);
  });

  it("reports nothing when nothing changed", () => {
    const rows = [fp("m1", "current", "aaa")];
    const changes = computeAppliedChanges(rows, rows);
    expect(changes).toEqual({ addedIds: [], updatedIds: [], deletedIds: [] });
  });
});

describe("describeScope", () => {
  it("renders all provided dimensions", () => {
    expect(
      describeScope({ user: "U1", channel: "C1", since: "2026-01-01", until: "2026-02-01" }),
    ).toBe("user=U1 channel=C1 since=2026-01-01 until=2026-02-01");
  });
});

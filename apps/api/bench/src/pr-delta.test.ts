/**
 * Unit tests for the PR-delta rendering. These are pure functions (no DB, no
 * network), so the suite stays hermetic.
 */

import { describe, expect, it } from "vitest";
import {
  diffEntries,
  loadBaselineEntry,
  PR_COMMENT_MARKER,
  renderPrComment,
  type BaselineScope,
} from "./pr-delta.js";
import type { HistoryEntry, HistoryScore } from "./results-log.js";

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  const scores: HistoryScore[] = overrides.scores ?? [
    { dataset: "longmemeval", category: "temporal-reasoning", qa: 0.4, recall: 0.77, n: 30 },
    { dataset: "locomo", category: "multi_hop", qa: 0.25, recall: 0.64, n: 30 },
  ];
  return {
    runId: "run-1",
    timestamp: "2026-05-29T08:00:00.000Z",
    commit: "abc1234",
    dirty: false,
    datasets: ["locomo", "longmemeval"],
    subset: "medium",
    limit: null,
    category: null,
    corpusHash: "corpus-aaa",
    caseSetHash: "case-bbb",
    runtimeMs: 60_000,
    costUsd: 4.2,
    models: { extraction: "fast", answerer: "main", judge: "escalation" },
    scores,
    overall: { qa: 0.33, recall: 0.7, n: 60 },
    ...overrides,
  };
}

const scope: BaselineScope = {
  corpusHash: "corpus-aaa",
  caseSetHash: "case-bbb",
  datasets: ["longmemeval", "locomo"],
  subset: "medium",
};

describe("loadBaselineEntry", () => {
  it("returns the newest comparable entry, ignoring order of datasets", () => {
    const older = makeEntry({ runId: "old", commit: "old1111" });
    const newer = makeEntry({ runId: "new", commit: "new2222" });
    const text = [older, newer].map((e) => JSON.stringify(e)).join("\n");
    const found = loadBaselineEntry(text, scope);
    expect(found?.commit).toBe("new2222");
  });

  it("skips PR-attributed entries (never diff against a PR)", () => {
    const main = makeEntry({ runId: "main", commit: "main111" });
    const pr = makeEntry({ runId: "pr", commit: "pr22222", prNumber: 42 });
    const text = [main, pr].map((e) => JSON.stringify(e)).join("\n");
    expect(loadBaselineEntry(text, scope)?.commit).toBe("main111");
  });

  it("returns null when corpus or case set differs", () => {
    const entry = makeEntry({ corpusHash: "different" });
    const text = JSON.stringify(entry);
    expect(loadBaselineEntry(text, scope)).toBeNull();
  });

  it("tolerates empty / malformed history text", () => {
    expect(loadBaselineEntry("", scope)).toBeNull();
    expect(loadBaselineEntry("not json\n{bad", scope)).toBeNull();
  });
});

describe("diffEntries", () => {
  it("computes per-cell and overall deltas", () => {
    const baseline = makeEntry();
    const current = makeEntry({
      scores: [
        { dataset: "longmemeval", category: "temporal-reasoning", qa: 0.46, recall: 0.79, n: 30 },
        { dataset: "locomo", category: "multi_hop", qa: 0.25, recall: 0.64, n: 30 },
      ],
      overall: { qa: 0.36, recall: 0.72, n: 60 },
    });
    const diff = diffEntries(current, baseline);
    expect(diff.hasBaseline).toBe(true);
    const tr = diff.cells.find((c) => c.category === "temporal-reasoning")!;
    expect(tr.deltaQa).toBeCloseTo(0.06, 5);
    expect(tr.deltaRecall).toBeCloseTo(0.02, 5);
    expect(diff.overall.deltaQa).toBeCloseTo(0.03, 5);
    expect(diff.regressions).toHaveLength(0);
  });

  it("flags regressions over the 2pp threshold", () => {
    const baseline = makeEntry();
    const current = makeEntry({
      scores: [
        // QA drops 4pp -> regression; recall flat.
        { dataset: "longmemeval", category: "temporal-reasoning", qa: 0.36, recall: 0.77, n: 30 },
        { dataset: "locomo", category: "multi_hop", qa: 0.25, recall: 0.64, n: 30 },
      ],
      overall: { qa: 0.305, recall: 0.7, n: 60 },
    });
    const diff = diffEntries(current, baseline);
    expect(diff.regressions).toHaveLength(1);
    expect(diff.regressions[0]).toMatchObject({
      category: "temporal-reasoning",
      metric: "QA",
    });
  });

  it("produces null deltas and hasBaseline=false when there's no baseline", () => {
    const current = makeEntry();
    const diff = diffEntries(current, null);
    expect(diff.hasBaseline).toBe(false);
    expect(diff.overall.deltaQa).toBeNull();
    for (const c of diff.cells) {
      expect(c.beforeQa).toBeNull();
      expect(c.deltaQa).toBeNull();
    }
  });
});

describe("renderPrComment", () => {
  const meta = {
    baseRef: "main",
    headCommit: "deadbeef",
    runId: "run-1",
    runtimeMs: 65_000,
    costUsd: 4.31,
    scope,
    runUrl: "https://example.test/run",
  };

  it("includes the marker and a delta table when a baseline exists", () => {
    const diff = diffEntries(makeEntry(), makeEntry());
    const md = renderPrComment(diff, meta);
    expect(md.startsWith(PR_COMMENT_MARKER)).toBe(true);
    expect(md).toContain("Δ vs target branch");
    expect(md).toContain("| **overall** |");
  });

  it("notes the absence of a baseline instead of faking deltas", () => {
    const diff = diffEntries(makeEntry(), null);
    const md = renderPrComment(diff, meta);
    expect(md).toContain("No comparable baseline");
  });

  it("renders a regression callout with the warning glyph", () => {
    const baseline = makeEntry();
    const current = makeEntry({
      scores: [
        { dataset: "longmemeval", category: "temporal-reasoning", qa: 0.3, recall: 0.77, n: 30 },
        { dataset: "locomo", category: "multi_hop", qa: 0.25, recall: 0.64, n: 30 },
      ],
      overall: { qa: 0.275, recall: 0.7, n: 60 },
    });
    const md = renderPrComment(diffEntries(current, baseline), meta);
    expect(md).toContain("regression(s)");
    expect(md).toContain("⚠️");
  });
});

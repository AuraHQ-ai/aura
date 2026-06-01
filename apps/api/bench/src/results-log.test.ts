import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authoritativeLatest,
  isAuthoritativeRun,
  materializeLatest,
  readHistory,
  writeHistory,
  writeLatest,
  type HistoryEntry,
} from "./results-log.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aura-bench-results-"));
  tempDirs.push(dir);
  return join(dir, name);
}

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    runId: "run-1",
    timestamp: "2026-06-01T09:00:00.000Z",
    commit: "abc1234",
    dirty: false,
    datasets: ["longmemeval"],
    subset: "toy",
    limit: null,
    category: null,
    corpusHash: "corpus-1",
    caseSetHash: "cases-1",
    runtimeMs: 1000,
    costUsd: 0.01,
    models: null,
    scores: [{ dataset: "longmemeval", category: "temporal", qa: 1, recall: 1, n: 2 }],
    overall: { qa: 1, recall: 1, n: 2 },
    ...overrides,
  };
}

describe("history and latest materialization", () => {
  it("writeHistory appends instead of overwriting", () => {
    const file = tempFile("history.jsonl");
    writeHistory([makeEntry({ runId: "first" })], file);
    writeHistory([makeEntry({ runId: "second", prNumber: 42 })], file);

    expect(readHistory(file).map((entry) => entry.runId)).toEqual(["first", "second"]);
  });

  it("materializes latest entries by like-for-like run characteristics", () => {
    const olderToy = makeEntry({ runId: "toy-old", commit: "old" });
    const fast = makeEntry({ runId: "fast", subset: "fast", caseSetHash: "fast-cases" });
    const newerToy = makeEntry({ runId: "toy-new", commit: "new" });

    const latest = materializeLatest([olderToy, fast, newerToy]).entries;

    expect(latest.map((entry) => entry.runId)).toEqual(["fast", "toy-new"]);
  });

  it("writes canonical latest.json as a materialized view", () => {
    const file = tempFile("latest.json");
    writeLatest([makeEntry({ runId: "old" }), makeEntry({ runId: "new" })], file);

    const json = JSON.parse(readFileSync(file, "utf8")) as { entries: HistoryEntry[] };
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0]?.runId).toBe("new");
  });
});

describe("authoritative-run gating (which runs may define the README snapshot)", () => {
  it("only a clean medium/full LongMemEval run is authoritative", () => {
    expect(
      isAuthoritativeRun({ subset: "medium", dirty: false, datasets: ["longmemeval"] }),
    ).toBe(true);
    expect(
      isAuthoritativeRun({ subset: "full", dirty: false, datasets: ["longmemeval"] }),
    ).toBe(true);
  });

  it("rejects toy runs even when they carry the default medium subset", () => {
    // `--dataset=toy` defaults to subset=medium; the dataset gate is what stops
    // a smoke test from clobbering a real baseline.
    expect(
      isAuthoritativeRun({ subset: "medium", dirty: false, datasets: ["toy"] }),
    ).toBe(false);
  });

  it("rejects fast subsets, LoCoMo-only runs, and dirty trees", () => {
    expect(
      isAuthoritativeRun({ subset: "fast", dirty: false, datasets: ["longmemeval"] }),
    ).toBe(false);
    expect(
      isAuthoritativeRun({ subset: "medium", dirty: false, datasets: ["locomo"] }),
    ).toBe(false);
    expect(
      isAuthoritativeRun({ subset: "medium", dirty: true, datasets: ["longmemeval"] }),
    ).toBe(false);
  });

  it("authoritativeLatest ignores toy/fast runs and returns undefined when none qualify", () => {
    const toy = makeEntry({ runId: "toy", subset: "medium", datasets: ["toy"] });
    const fast = makeEntry({ runId: "fast", subset: "fast", datasets: ["longmemeval"] });
    expect(authoritativeLatest([toy, fast])).toBeUndefined();

    const realMedium = makeEntry({
      runId: "lme-medium",
      subset: "medium",
      datasets: ["longmemeval"],
    });
    // A later toy run must not displace the medium LongMemEval baseline.
    const laterToy = makeEntry({ runId: "toy-2", subset: "medium", datasets: ["toy"] });
    expect(authoritativeLatest([realMedium, laterToy])?.runId).toBe("lme-medium");
  });
});

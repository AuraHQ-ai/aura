process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

import { describe, expect, it, vi } from "vitest";

// Mock the db client so the test stays hermetic — the pure functions under
// test never actually touch Postgres.
vi.mock("../../src/db/client.js", () => ({ db: {} }));

import { aggregateScores } from "./score.js";
import type { PerCaseResult } from "./types.js";
import { loadToyCorpus, stratifiedSample, SUBSET_PER_CATEGORY } from "./fixtures.js";
import { formatMemoriesForPrompt } from "../../src/memory/format-for-prompt.js";
import { DEFAULT_TIERS } from "./models.js";
import type { BenchCase } from "./types.js";

function makeResult(overrides: Partial<PerCaseResult>): PerCaseResult {
  return {
    caseId: "c",
    dataset: "toy",
    category: "single_hop",
    question: "?",
    goldAnswer: "x",
    abstention: false,
    retrievedMemoryIds: [],
    retrievedRecallHit: null,
    modelAnswer: "",
    judgeVerdict: "correct",
    judgeConfidence: 1,
    judgeRationale: "",
    durationMs: 1,
    ...overrides,
  };
}

describe("aggregateScores", () => {
  it("counts correct as 1, partial as 0.5, incorrect as 0", () => {
    const results = [
      makeResult({ judgeVerdict: "correct" }),
      makeResult({ judgeVerdict: "partial" }),
      makeResult({ judgeVerdict: "incorrect" }),
      makeResult({ judgeVerdict: "correct" }),
    ];
    const scores = aggregateScores(results);
    const qa = scores.find((s) => s.scoreType === "qa_accuracy");
    expect(qa).toBeDefined();
    expect(qa!.n).toBe(4);
    expect(qa!.nCorrect).toBe(2);
    expect(qa!.score).toBe((2 + 0.5) / 4);
  });

  it("retrieval recall ignores null hits and tracks true/false", () => {
    const results = [
      makeResult({ retrievedRecallHit: true }),
      makeResult({ retrievedRecallHit: true }),
      makeResult({ retrievedRecallHit: false }),
      makeResult({ retrievedRecallHit: null }),
    ];
    const scores = aggregateScores(results);
    const recall = scores.find((s) => s.scoreType === "retrieval_recall_at_15");
    expect(recall).toBeDefined();
    expect(recall!.n).toBe(3);
    expect(recall!.nCorrect).toBe(2);
    expect(recall!.score).toBeCloseTo(2 / 3, 5);
  });

  it("abstention lane fires only when there are abstention cases", () => {
    const results = [
      makeResult({ abstention: true, judgeVerdict: "abstain_ok", category: "abstention" }),
      makeResult({ abstention: true, judgeVerdict: "incorrect", category: "abstention" }),
    ];
    const scores = aggregateScores(results);
    const abs = scores.find((s) => s.scoreType === "abstention_accuracy");
    expect(abs).toBeDefined();
    expect(abs!.n).toBe(2);
    expect(abs!.nCorrect).toBe(1);
    expect(abs!.score).toBe(0.5);
  });

  it("does not produce QA rows for an all-skipped group", () => {
    const results = [makeResult({ judgeVerdict: "skipped" })];
    const scores = aggregateScores(results);
    expect(scores.find((s) => s.scoreType === "qa_accuracy")).toBeUndefined();
  });

  it("groups by (dataset, category)", () => {
    const results = [
      makeResult({ category: "temporal" }),
      makeResult({ category: "temporal" }),
      makeResult({ category: "multi_hop", judgeVerdict: "incorrect" }),
    ];
    const scores = aggregateScores(results);
    const qa = scores.filter((s) => s.scoreType === "qa_accuracy");
    expect(qa.length).toBe(2);
    const temporal = qa.find((s) => s.category === "temporal");
    expect(temporal!.score).toBe(1);
    const multi = qa.find((s) => s.category === "multi_hop");
    expect(multi!.score).toBe(0);
  });
});

describe("formatMemoriesForPrompt (shared with production)", () => {
  it("returns empty string for no memories so the system prompt can elide the block", () => {
    expect(formatMemoriesForPrompt([])).toBe("");
  });

  it("emits one bulleted line per memory with type tag and about-clause", () => {
    const mem = {
      id: "m1",
      type: "fact",
      content: "Alex adopted a dog named Pepper",
      relatedUserIds: ["alex"],
      createdAt: new Date(),
      validFrom: new Date(),
    } as any;
    const out = formatMemoriesForPrompt([mem, mem]);
    expect(out).toContain("These are things you've learned");
    const bullets = out.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBe(2);
    expect(bullets[0]).toContain("[fact]");
    expect(bullets[0]).toContain("Pepper");
    expect(bullets[0]).toContain("[about: alex]");
  });
});

describe("stratifiedSample", () => {
  function makeCase(category: string, id: string): BenchCase {
    return {
      id,
      source: "toy",
      category,
      question: "?",
      goldAnswer: "x",
      abstention: false,
      sessions: [],
    };
  }

  it("samples deterministically and respects per-category cap", () => {
    const cases: BenchCase[] = [];
    for (let i = 0; i < 10; i++) cases.push(makeCase("a", `a${i}`));
    for (let i = 0; i < 10; i++) cases.push(makeCase("b", `b${i}`));
    for (let i = 0; i < 2; i++) cases.push(makeCase("c", `c${i}`));

    const first = stratifiedSample(cases, 3, 4711);
    const second = stratifiedSample(cases, 3, 4711);
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));

    const counts = new Map<string, number>();
    for (const c of first) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
    expect(counts.get("a")).toBe(3);
    expect(counts.get("b")).toBe(3);
    expect(counts.get("c")).toBe(2);
  });

  it("differs across seeds", () => {
    const cases: BenchCase[] = [];
    for (let i = 0; i < 20; i++) cases.push(makeCase("a", `a${i}`));
    const a = stratifiedSample(cases, 5, 1).map((c) => c.id).sort();
    const b = stratifiedSample(cases, 5, 2).map((c) => c.id).sort();
    expect(a).not.toEqual(b);
  });

  it("subset table defines fast < medium < full", () => {
    expect(SUBSET_PER_CATEGORY.fast).toBeLessThan(SUBSET_PER_CATEGORY.medium);
    expect(SUBSET_PER_CATEGORY.medium).toBeLessThan(SUBSET_PER_CATEGORY.full);
  });
});

describe("loadToyCorpus", () => {
  it("loads the vendored toy fixture with parsed evidence", async () => {
    const cases = await loadToyCorpus();
    expect(cases.length).toBe(3);
    const categories = cases.map((c) => c.category).sort();
    expect(categories).toEqual(["abstention", "single_hop", "temporal"]);
    const abstention = cases.find((c) => c.abstention)!;
    expect(abstention.category).toBe("abstention");
    const singleHop = cases.find((c) => c.category === "single_hop")!;
    expect(singleHop.evidenceDiaIds).toContain("S1:2");
    expect(singleHop.sessions[0].turns.length).toBe(3);
  });
});

describe("bench tier defaults", () => {
  it("pins extraction + answerer to main and judge to escalation", () => {
    // Tiers are declarative knobs that map onto whatever's in the live
    // model catalog. The exact gateway ids resolved at runtime are
    // captured in bench_runs so cross-run deltas stay honest.
    expect(DEFAULT_TIERS.extraction).toBe("main");
    expect(DEFAULT_TIERS.answerer).toBe("main");
    expect(DEFAULT_TIERS.judge).toBe("escalation");
  });
});

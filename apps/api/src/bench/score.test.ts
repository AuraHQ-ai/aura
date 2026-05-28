import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));

import { aggregateScores } from "./score.js";
import type { PerCaseResult } from "./types.js";
import { stratifiedSample, SUBSET_PER_CATEGORY } from "./fixtures.js";
import { resolveBenchModels, DEFAULT_JUDGE_MODEL, DEFAULT_EXTRACTION_MODEL } from "./models.js";
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
  it("gives partial verdicts half credit", () => {
    const scores = aggregateScores([
      makeResult({ judgeVerdict: "correct" }),
      makeResult({ judgeVerdict: "partial" }),
      makeResult({ judgeVerdict: "incorrect" }),
    ]);
    const qa = scores.find((s) => s.scoreType === "qa_accuracy")!;
    expect(qa.score).toBeCloseTo((1 + 0.5) / 3, 5);
  });

  it("scores retrieval recall only when hit is non-null", () => {
    const scores = aggregateScores([
      makeResult({ retrievedRecallHit: true }),
      makeResult({ retrievedRecallHit: false }),
      makeResult({ retrievedRecallHit: null }),
    ]);
    const recall = scores.find((s) => s.scoreType === "retrieval_recall_at_15")!;
    expect(recall.n).toBe(2);
    expect(recall.score).toBe(0.5);
  });
});

describe("stratifiedSample", () => {
  it("is deterministic for a fixed seed", () => {
    const cases: BenchCase[] = [];
    for (let i = 0; i < 10; i++) {
      cases.push({
        id: `a${i}`,
        source: "toy",
        category: "a",
        question: "?",
        goldAnswer: "x",
        abstention: false,
        sessions: [],
      });
    }
    const a = stratifiedSample(cases, 3, 1043).map((c) => c.id);
    const b = stratifiedSample(cases, 3, 1043).map((c) => c.id);
    expect(a).toEqual(b);
  });
});

describe("resolveBenchModels", () => {
  it("defaults to Sonnet extraction and Opus judge", () => {
    const prev = {
      BENCH_EXTRACTION_MODEL: process.env.BENCH_EXTRACTION_MODEL,
      BENCH_JUDGE_MODEL: process.env.BENCH_JUDGE_MODEL,
    };
    delete process.env.BENCH_EXTRACTION_MODEL;
    delete process.env.BENCH_JUDGE_MODEL;
    const m = resolveBenchModels();
    expect(m.extraction).toBe(DEFAULT_EXTRACTION_MODEL);
    expect(m.judge).toBe(DEFAULT_JUDGE_MODEL);
    process.env.BENCH_EXTRACTION_MODEL = prev.BENCH_EXTRACTION_MODEL;
    process.env.BENCH_JUDGE_MODEL = prev.BENCH_JUDGE_MODEL;
  });
});

describe("SUBSET_PER_CATEGORY", () => {
  it("fast < medium < full", () => {
    expect(SUBSET_PER_CATEGORY.fast).toBeLessThan(SUBSET_PER_CATEGORY.medium);
  });
});

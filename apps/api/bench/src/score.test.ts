process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

import { describe, expect, it, vi } from "vitest";
import { aggregateScores } from "./score.js";
import { loadToyCorpus, stratifiedSample, SUBSET_PER_CATEGORY } from "./fixtures.js";
import {
  DEFAULT_EXTRACTION_MODEL,
  DEFAULT_JUDGE_MODEL,
  resolveBenchModels,
} from "./models.js";
import { formatMemoriesForPrompt } from "../../src/memory/format-for-prompt.js";
import type { BenchCase, BenchCaseResult } from "./types.js";

vi.mock("../../src/db/client.js", () => ({ db: {} }));

function makeResult(overrides: Partial<BenchCaseResult>): BenchCaseResult {
  return {
    caseId: "c",
    dataset: "toy",
    category: "single_hop",
    retrievedMemoryIds: [],
    retrievalHit: null,
    abstention: false,
    verdict: "correct",
    qaCorrect: true,
    ...overrides,
  };
}

describe("aggregateScores", () => {
  it("counts correct as 1, partial as 0.5, incorrect as 0", () => {
    const aggregates = aggregateScores({
      runId: "r",
      includeQa: true,
      cases: [
        makeResult({ verdict: "correct" }),
        makeResult({ verdict: "partial", qaCorrect: false }),
        makeResult({ verdict: "incorrect", qaCorrect: false }),
        makeResult({ verdict: "correct" }),
      ],
    });
    const qa = aggregates.find((score) => score.scoreType === "qa_accuracy");
    expect(qa?.n).toBe(4);
    expect(qa?.nCorrect).toBe(2);
    expect(qa?.score).toBe((2 + 0.5) / 4);
  });

  it("retrieval recall ignores null hits", () => {
    const aggregates = aggregateScores({
      runId: "r",
      includeQa: false,
      cases: [
        makeResult({ retrievalHit: true }),
        makeResult({ retrievalHit: true }),
        makeResult({ retrievalHit: false }),
        makeResult({ retrievalHit: null }),
      ],
    });
    const recall = aggregates.find((score) => score.scoreType === "retrieval_recall_at_15");
    expect(recall?.n).toBe(3);
    expect(recall?.nCorrect).toBe(2);
    expect(recall?.score).toBeCloseTo(2 / 3, 5);
  });

  it("emits an abstention accuracy lane", () => {
    const aggregates = aggregateScores({
      runId: "r",
      includeQa: true,
      cases: [
        makeResult({ abstention: true, category: "abstention", verdict: "abstain_ok" }),
        makeResult({ abstention: true, category: "abstention", verdict: "incorrect" }),
      ],
    });
    const abstention = aggregates.find((score) => score.scoreType === "abstention_accuracy");
    expect(abstention?.n).toBe(2);
    expect(abstention?.nCorrect).toBe(1);
    expect(abstention?.score).toBe(0.5);
  });
});

describe("fixture helpers", () => {
  function benchCase(category: string, id: string): BenchCase {
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

  it("loads the vendored toy corpus", async () => {
    const cases = await loadToyCorpus();
    expect(cases.length).toBe(5);
    expect(cases.some((benchCase) => benchCase.category === "abstention")).toBe(true);
  });

  it("samples deterministically by category", () => {
    const cases: BenchCase[] = [];
    for (let index = 0; index < 10; index++) cases.push(benchCase("a", `a${index}`));
    for (let index = 0; index < 10; index++) cases.push(benchCase("b", `b${index}`));

    const first = stratifiedSample(cases, 3, 4711).map((benchCase) => benchCase.id);
    const second = stratifiedSample(cases, 3, 4711).map((benchCase) => benchCase.id);
    expect(first).toEqual(second);
    expect(first.length).toBe(6);
  });

  it("defines fast < medium < full", () => {
    expect(SUBSET_PER_CATEGORY.fast).toBeLessThan(SUBSET_PER_CATEGORY.medium);
    expect(SUBSET_PER_CATEGORY.medium).toBeLessThan(SUBSET_PER_CATEGORY.full);
  });
});

describe("model and prompt helpers", () => {
  it("defaults to Sonnet extraction and Opus judge", () => {
    delete process.env.MEMORY_BENCH_EXTRACTION_MODEL;
    delete process.env.MEMORY_BENCH_JUDGE_MODEL;
    const models = resolveBenchModels();
    expect(models.extraction).toBe(DEFAULT_EXTRACTION_MODEL);
    expect(models.judge).toBe(DEFAULT_JUDGE_MODEL);
    expect(models.extraction).toContain("sonnet");
    expect(models.judge).toContain("opus");
  });

  it("formats memories with type and related users", () => {
    const output = formatMemoriesForPrompt([
      {
        type: "fact",
        content: "Alex adopted a dog named Pepper",
        relatedUserIds: ["alex"],
        createdAt: new Date("2024-09-01T10:00:00.000Z"),
      } as any,
    ]);
    expect(output).toContain("[fact]");
    expect(output).toContain("Pepper");
    expect(output).toContain("[about: alex]");
  });
});

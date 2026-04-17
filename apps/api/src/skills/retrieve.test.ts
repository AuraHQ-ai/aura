import { describe, expect, it } from "vitest";
import {
  applySkillTokenCap,
  filterSkillsByThreshold,
  mapRowsToRetrievedSkills,
  type SkillRetrievalRow,
} from "./retrieve.js";

describe("skill retrieval ranking and gating", () => {
  const rows: SkillRetrievalRow[] = [
    { id: "s1", topic: "alpha", content: "A".repeat(1200), similarity: 0.71 },
    { id: "s2", topic: "beta", content: "B".repeat(1200), similarity: 0.52 },
    { id: "s3", topic: "gamma", content: "C".repeat(1200), similarity: 0.40 },
    { id: "s4", topic: "delta", content: "D".repeat(1200), similarity: 0.36 },
    { id: "s5", topic: "epsilon", content: "E".repeat(1200), similarity: 0.349 },
    { id: "s6", topic: "zeta", content: "F".repeat(1200), similarity: 0.20 },
  ];

  it("keeps top-K over threshold", () => {
    const retrieved = mapRowsToRetrievedSkills(filterSkillsByThreshold(rows, 0.35));
    expect(retrieved.map((s: { id: string }) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("drops lowest-scoring skills first when over token cap", () => {
    const retrieved = mapRowsToRetrievedSkills(filterSkillsByThreshold(rows, 0.35));
    const capped = applySkillTokenCap(retrieved, 700);
    expect(capped.map((s: { id: string }) => s.id)).toEqual(["s1", "s2"]);
  });
});

describe("skill retrieval threshold defaults", () => {
  it("default threshold of 0.55 excludes marginal matches", () => {
    // Simulates the new default. 0.35-0.52 range was noise at old threshold.
    const marginalRows: SkillRetrievalRow[] = [
      { id: "weak1", topic: "weak", content: "X".repeat(500), similarity: 0.40 },
      { id: "weak2", topic: "weaker", content: "X".repeat(500), similarity: 0.50 },
      { id: "strong", topic: "strong", content: "X".repeat(500), similarity: 0.62 },
    ];
    const kept = filterSkillsByThreshold(marginalRows, 0.55);
    expect(kept.map((r) => r.id)).toEqual(["strong"]);
  });
});

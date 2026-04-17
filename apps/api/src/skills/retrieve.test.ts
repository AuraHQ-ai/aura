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

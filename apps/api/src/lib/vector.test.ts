import { describe, it, expect } from "vitest";
import { blendEmbeddings } from "./vector.js";

/** Cosine similarity for test assertions. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("blendEmbeddings (#1038 last-message weighting)", () => {
  it("returns an L2-normalized vector", () => {
    const out = blendEmbeddings(
      [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
      ],
      [0.65, 0.35],
    );
    const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("leans toward the latest message when latestWeight > 0.5", () => {
    // latest = topic B axis, context = topic A axis (orthogonal)
    const latest = [0, 1, 0, 0];
    const context = [1, 0, 0, 0];
    const blended = blendEmbeddings([latest, context], [0.65, 0.35]);
    // The blended query must be more similar to the pivoted (latest) topic
    // than to the prior context — otherwise topic-pivot dilution persists.
    expect(cosine(blended, latest)).toBeGreaterThan(cosine(blended, context));
  });

  it("equal weights produce a vector equidistant from both inputs", () => {
    const a = [1, 0, 0, 0];
    const b = [0, 1, 0, 0];
    const blended = blendEmbeddings([a, b], [0.5, 0.5]);
    expect(cosine(blended, a)).toBeCloseTo(cosine(blended, b), 6);
  });

  it("rejects mismatched vector/weight counts", () => {
    expect(() => blendEmbeddings([[1, 0]], [0.5, 0.5])).toThrow();
  });

  it("falls back to the first vector when the weighted sum is degenerate", () => {
    // Opposite vectors with equal weight cancel to the zero vector; we must
    // not emit a zero (or NaN) embedding — pgvector cosine would be undefined.
    const a = [1, 0, 0, 0];
    const b = [-1, 0, 0, 0];
    const blended = blendEmbeddings([a, b], [0.5, 0.5]);
    expect(blended).toEqual(a);
  });
});

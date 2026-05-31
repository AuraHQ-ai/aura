/**
 * Pure vector math helpers — intentionally free of any DB / AI-client imports so
 * they can be unit-tested without a live `DATABASE_URL` or embedding gateway.
 */

/**
 * Blend several embedding vectors into one via a weighted sum, then L2-normalize.
 * Used to build a query embedding that leans toward the most recent message while
 * still carrying prior thread context (cosine search is scale-invariant, so the
 * re-normalization keeps the blended vector well-formed).
 */
export function blendEmbeddings(
  vectors: number[][],
  weights: number[],
): number[] {
  if (vectors.length === 0) {
    throw new Error("blendEmbeddings: no vectors provided");
  }
  if (vectors.length !== weights.length) {
    throw new Error(
      `blendEmbeddings: ${vectors.length} vectors but ${weights.length} weights`,
    );
  }
  const dims = vectors[0].length;
  const acc = new Array<number>(dims).fill(0);
  for (let v = 0; v < vectors.length; v++) {
    const vec = vectors[v];
    const w = weights[v];
    if (vec.length !== dims) {
      throw new Error(
        `blendEmbeddings: dimension mismatch (${vec.length} vs ${dims})`,
      );
    }
    for (let i = 0; i < dims; i++) acc[i] += vec[i] * w;
  }
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += acc[i] * acc[i];
  norm = Math.sqrt(norm);
  if (norm === 0 || !Number.isFinite(norm)) return vectors[0];
  for (let i = 0; i < dims; i++) acc[i] /= norm;
  return acc;
}

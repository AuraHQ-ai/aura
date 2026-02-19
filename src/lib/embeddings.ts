import { embed, embedMany } from "ai";
import { getEmbeddingModel } from "./ai.js";
import { logger } from "./logger.js";

/**
 * Target dimensions for stored embeddings.
 * text-embedding-3-large natively outputs 3072d, but pgvector HNSW indexes
 * cap at 2000d. We truncate + re-normalize (Matryoshka representation
 * learning means the leading dimensions carry the most signal).
 */
export const EMBEDDING_DIMENSIONS = 2000;

/**
 * Truncate a vector to EMBEDDING_DIMENSIONS and L2-normalize it.
 */
function truncateAndNormalize(vec: number[]): number[] {
  const truncated = vec.slice(0, EMBEDDING_DIMENSIONS);
  const norm = Math.sqrt(truncated.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return truncated;
  return truncated.map((v) => v / norm);
}

/**
 * Embed a single text string into a 2000-dimensional vector.
 */
export async function embedText(text: string): Promise<number[]> {
  const start = Date.now();
  const model = await getEmbeddingModel();
  const { embedding } = await embed({
    model,
    value: text,
  });
  logger.debug(`Embedded text in ${Date.now() - start}ms`, {
    textLength: text.length,
  });
  return truncateAndNormalize(embedding);
}

/**
 * Embed multiple text strings in a single batch call.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const start = Date.now();
  const model = await getEmbeddingModel();
  const { embeddings } = await embedMany({
    model,
    values: texts,
  });
  logger.debug(`Embedded ${texts.length} texts in ${Date.now() - start}ms`);
  return embeddings.map(truncateAndNormalize);
}

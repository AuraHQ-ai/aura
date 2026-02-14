import { embed, embedMany } from "ai";
import { getEmbeddingModel } from "./ai.js";
import { logger } from "./logger.js";

/**
 * Embed a single text string into a 1536-dimensional vector.
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
  return embedding;
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
  return embeddings;
}

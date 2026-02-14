import { embed, embedMany } from "ai";
import { embeddingModel } from "./ai.js";
import { logger } from "./logger.js";

/**
 * Embed a single text string into a 1536-dimensional vector.
 */
export async function embedText(text: string): Promise<number[]> {
  const start = Date.now();
  const { embedding } = await embed({
    model: embeddingModel,
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
  const { embeddings } = await embedMany({
    model: embeddingModel,
    values: texts,
  });
  logger.debug(`Embedded ${texts.length} texts in ${Date.now() - start}ms`);
  return embeddings;
}

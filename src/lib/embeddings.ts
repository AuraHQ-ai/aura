import { embed, embedMany } from "ai";
import { getEmbeddingModel } from "./ai.js";
import { logger } from "./logger.js";

const EXPECTED_DIMENSIONS = 1536;

/**
 * Validate an embedding vector: must be a non-empty number array with
 * the expected dimensions and no NaN/Infinity values.
 */
function validateEmbedding(embedding: unknown, label: string): number[] {
  if (!Array.isArray(embedding)) {
    throw new Error(
      `${label}: expected number[], got ${typeof embedding}`,
    );
  }
  if (embedding.length === 0) {
    throw new Error(`${label}: embedding is an empty array`);
  }
  if (embedding.length !== EXPECTED_DIMENSIONS) {
    throw new Error(
      `${label}: expected ${EXPECTED_DIMENSIONS} dimensions, got ${embedding.length}`,
    );
  }
  for (let i = 0; i < embedding.length; i++) {
    if (typeof embedding[i] !== "number" || !Number.isFinite(embedding[i])) {
      throw new Error(
        `${label}: invalid value at index ${i}: ${embedding[i]}`,
      );
    }
  }
  return embedding as number[];
}

/**
 * Embed a single text string into a 1536-dimensional vector.
 */
export async function embedText(text: string): Promise<number[]> {
  const start = Date.now();
  try {
    const model = await getEmbeddingModel();
    const result = await embed({ model, value: text });
    const validated = validateEmbedding(
      result.embedding,
      "embedText",
    );
    logger.debug(`Embedded text in ${Date.now() - start}ms`, {
      textLength: text.length,
      dimensions: validated.length,
    });
    return validated;
  } catch (error) {
    logger.error("embedText failed", {
      error: String(error),
      stack: (error as Error).stack?.split("\n").slice(0, 5).join(" | "),
      textLength: text.length,
      textPreview: text.substring(0, 80),
      elapsedMs: Date.now() - start,
    });
    throw error;
  }
}

/**
 * Embed multiple text strings in a single batch call.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const start = Date.now();
  try {
    const model = await getEmbeddingModel();
    const result = await embedMany({ model, values: texts });

    if (!result.embeddings || !Array.isArray(result.embeddings)) {
      throw new Error(
        `embedMany returned invalid embeddings: ${typeof result.embeddings}`,
      );
    }
    if (result.embeddings.length !== texts.length) {
      throw new Error(
        `embedMany returned ${result.embeddings.length} embeddings for ${texts.length} texts`,
      );
    }

    const validated = result.embeddings.map((emb, i) =>
      validateEmbedding(emb, `embedTexts[${i}]`),
    );

    logger.debug(`Embedded ${texts.length} texts in ${Date.now() - start}ms`, {
      dimensions: validated[0]?.length,
    });
    return validated;
  } catch (error) {
    logger.error("embedTexts failed", {
      error: String(error),
      stack: (error as Error).stack?.split("\n").slice(0, 5).join(" | "),
      count: texts.length,
      textLengths: texts.map((t) => t.length),
      elapsedMs: Date.now() - start,
    });
    throw error;
  }
}

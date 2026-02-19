import { sql, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories, type Memory } from "../db/schema.js";
import { embedText } from "../lib/embeddings.js";
import { logger } from "../lib/logger.js";

interface RetrievalOptions {
  /** The user's current message text */
  query: string;
  /** Maximum number of memories to return */
  limit?: number;
  /** Minimum relevance score threshold */
  minRelevanceScore?: number;
}

/**
 * Retrieve relevant memories using semantic search (pgvector).
 *
 * Flow:
 * 1. Embed the user's message
 * 2. Query pgvector for nearest neighbors
 * 3. Weight by relevance_score and recency
 * 4. Return top-K memories
 */
export async function retrieveMemories(
  options: RetrievalOptions,
): Promise<Memory[]> {
  const { query, limit = 20, minRelevanceScore = 0.1 } = options;
  const start = Date.now();

  try {
    // 1. Embed the query
    const queryEmbedding = await embedText(query);

    // 2. Query pgvector for nearest neighbors
    const results = await db
      .select({
        memory: memories,
        similarity: sql<number>`1 - (${memories.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector)`.as("similarity"),
      })
      .from(memories)
      .where(
        and(
          sql`${memories.embedding} IS NOT NULL`,
          sql`${memories.relevanceScore} >= ${minRelevanceScore}`,
        ),
      )
      .orderBy(
        sql`${memories.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector`,
      )
      .limit(limit);

    // 3. Score: combine cosine similarity with relevance_score and recency
    const now = Date.now();
    const scored = results.map(({ memory, similarity }) => {

      // Recency boost: memories from the last 24h get a boost, older ones decay
      const ageMs = now - new Date(memory.createdAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const recencyBoost = Math.max(0, 1 - ageDays / 365); // Linear decay over a year

      // Combined score
      const score =
        similarity * 0.6 +
        memory.relevanceScore * 0.25 +
        recencyBoost * 0.15;

      return { memory, score };
    });

    // 4. Sort by combined score and return top-K
    scored.sort((a, b) => b.score - a.score);
    const topMemories = scored.map((s) => s.memory);

    logger.info(`Retrieved ${topMemories.length} memories in ${Date.now() - start}ms`, {
      query: query.substring(0, 100),
      totalCandidates: results.length,
    });

    return topMemories;
  } catch (error) {
    logger.error("Memory retrieval failed", {
      error: String(error),
      query: query.substring(0, 100),
    });
    // Return empty — don't crash the pipeline over retrieval failure
    return [];
  }
}

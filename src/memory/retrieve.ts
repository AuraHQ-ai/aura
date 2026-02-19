import { sql, and, eq, or, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories, messages, type Memory, type Message } from "../db/schema.js";
import { embedText } from "../lib/embeddings.js";
import { logger } from "../lib/logger.js";

interface RetrievalOptions {
  /** The user's current message text */
  query: string;
  /** Pre-computed query embedding (avoids double-embedding when called alongside retrieveConversations) */
  queryEmbedding?: number[];
  /** The Slack user ID of the person asking */
  currentUserId: string;
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
 * 3. Apply privacy filtering (FR-2.4)
 * 4. Weight by relevance_score and recency
 * 5. Return top-K memories
 */
export async function retrieveMemories(
  options: RetrievalOptions,
): Promise<Memory[]> {
  const { query, queryEmbedding: precomputed, currentUserId, limit = 20, minRelevanceScore = 0.1 } = options;
  const start = Date.now();

  try {
    // 1. Embed the query (use pre-computed if available)
    const queryEmbedding = precomputed ?? await embedText(query);

    // 2. Query pgvector for nearest neighbors
    const fetchLimit = limit;
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
      .limit(fetchLimit);

    // 3. No privacy filtering — full transparency (corporate policy)
    const filtered = results.map((r) => r.memory);

    // 4. Score: combine cosine similarity with relevance_score and recency
    const now = Date.now();
    const scored = filtered.map((memory) => {
      const result = results.find((r) => r.memory.id === memory.id);
      const similarity = result?.similarity ?? 0;

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

    // 5. Sort by combined score and return top-K
    scored.sort((a, b) => b.score - a.score);
    const topMemories = scored.slice(0, limit).map((s) => s.memory);

    logger.info(`Retrieved ${topMemories.length} memories in ${Date.now() - start}ms`, {
      query: query.substring(0, 100),
      totalCandidates: results.length,
      afterPrivacyFilter: filtered.length,
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

// ── Conversation-level retrieval ─────────────────────────────────────────────

export interface ConversationThread {
  /** The thread identifier (slack_thread_ts of the root message) */
  threadTs: string;
  /** Channel where the conversation happened */
  channelId: string;
  /** All messages in this thread, ordered chronologically */
  messages: Message[];
  /** Best similarity score among matched messages in this thread */
  bestSimilarity: number;
}

interface ConversationRetrievalOptions {
  /** The user's current message text */
  query: string;
  /** Pre-computed query embedding (avoids double-embedding when called alongside retrieveMemories) */
  queryEmbedding?: number[];
  /** Maximum number of individual message matches to search */
  matchLimit?: number;
  /** Maximum number of conversation threads to return */
  threadLimit?: number;
  /** Minimum cosine similarity threshold for message matches */
  minSimilarity?: number;
}

/**
 * Retrieve full conversation threads via semantic search on message embeddings.
 *
 * Flow:
 * 1. Embed the query
 * 2. Find the most similar messages via pgvector
 * 3. Group matched messages by thread (slack_thread_ts)
 * 4. Fetch all messages belonging to each matched thread
 * 5. Return full threads sorted by best match score
 */
export async function retrieveConversations(
  options: ConversationRetrievalOptions,
): Promise<ConversationThread[]> {
  const {
    query,
    queryEmbedding: precomputed,
    matchLimit = 20,
    threadLimit = 5,
    minSimilarity = 0.3,
  } = options;
  const start = Date.now();

  try {
    const queryEmbedding = precomputed ?? await embedText(query);
    const embeddingLiteral = JSON.stringify(queryEmbedding);

    // Find the most similar messages
    const matchedMessages = await db
      .select({
        message: messages,
        similarity: sql<number>`1 - (${messages.embedding} <=> ${embeddingLiteral}::vector)`.as("similarity"),
      })
      .from(messages)
      .where(sql`${messages.embedding} IS NOT NULL`)
      .orderBy(sql`${messages.embedding} <=> ${embeddingLiteral}::vector`)
      .limit(matchLimit);

    // Filter by minimum similarity
    const relevant = matchedMessages.filter((r) => r.similarity >= minSimilarity);

    if (relevant.length === 0) {
      logger.debug("No relevant messages found for conversation retrieval", {
        query: query.substring(0, 100),
      });
      return [];
    }

    // Group by thread: use slack_thread_ts if present, otherwise slack_ts (top-level message)
    const threadMap = new Map<string, { channelId: string; bestSimilarity: number }>();
    for (const r of relevant) {
      const threadKey = r.message.slackThreadTs || r.message.slackTs;
      const existing = threadMap.get(threadKey);
      if (!existing || r.similarity > existing.bestSimilarity) {
        threadMap.set(threadKey, {
          channelId: r.message.channelId,
          bestSimilarity: r.similarity,
        });
      }
    }

    // Sort threads by best similarity and take top N
    const sortedThreads = [...threadMap.entries()]
      .sort((a, b) => b[1].bestSimilarity - a[1].bestSimilarity)
      .slice(0, threadLimit);

    if (sortedThreads.length === 0) return [];

    // Fetch all messages for each thread
    const threadKeys = sortedThreads.map(([key]) => key);
    const threadMessages = await db
      .select()
      .from(messages)
      .where(
        or(
          inArray(messages.slackThreadTs, threadKeys),
          inArray(messages.slackTs, threadKeys),
        )!,
      )
      .orderBy(messages.createdAt);

    // Build thread objects
    const conversationThreads: ConversationThread[] = sortedThreads.map(
      ([threadTs, meta]) => {
        const threadMsgs = threadMessages.filter(
          (m) => m.slackThreadTs === threadTs || m.slackTs === threadTs,
        );
        return {
          threadTs,
          channelId: meta.channelId,
          messages: threadMsgs,
          bestSimilarity: meta.bestSimilarity,
        };
      },
    );

    logger.info(
      `Retrieved ${conversationThreads.length} conversation threads (${relevant.length} matched messages) in ${Date.now() - start}ms`,
      { query: query.substring(0, 100) },
    );

    return conversationThreads;
  } catch (error) {
    logger.error("Conversation retrieval failed", {
      error: String(error),
      query: query.substring(0, 100),
    });
    return [];
  }
}

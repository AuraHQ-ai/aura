import { sql, or, inArray } from "drizzle-orm";
import { rerank } from "ai";
import { db } from "../db/client.js";
import { memories, messages, type Memory, type Message } from "@aura/db/schema";
import { embedText } from "../lib/embeddings.js";
import { getRerankingModel } from "../lib/ai.js";
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

const MAX_FULLTEXT_LEXEMES = 8;
const PER_TERM_FULLTEXT_LIMIT = 25;

async function extractLexemes(
  query: string,
  maxLexemes = MAX_FULLTEXT_LEXEMES,
): Promise<string[]> {
  if (!query.trim()) return [];

  try {
    const result = await db.execute(sql`
      SELECT lexeme AS term
      FROM unnest(to_tsvector('english', ${query})) AS token(lexeme, positions, weights)
      ORDER BY positions[1] ASC NULLS LAST, lexeme ASC
      LIMIT ${maxLexemes}
    `);

    const rows = ((result as any).rows ?? result) as Array<{ term?: string | null }>;
    const SAFE_LEXEME = /^[a-z0-9]+$/;
    return rows
      .map((row) => row.term?.trim() ?? "")
      .filter((term): term is string => term.length > 0 && SAFE_LEXEME.test(term));
  } catch (error) {
    logger.warn("Failed to extract positional lexemes; falling back to vector-only ranking", {
      error: String(error),
      query: query.substring(0, 100),
    });
    return [];
  }
}

/**
 * Retrieve relevant memories using hybrid search (vector + full-text) with RRF fusion.
 *
 * Flow:
 * 1. Embed the user's message
 * 2. Extract up to 8 positional lexemes from Postgres full-text parsing
 * 3. Run hybrid SQL: pgvector + per-term full-text lanes merged by best rank
 * 4. Fuse results via Reciprocal Rank Fusion (RRF) with FULL OUTER JOIN
 * 5. Rerank top candidates with Cohere (or fall back to legacy scoring)
 * 6. Return top-K memories
 */
export async function retrieveMemories(
  options: RetrievalOptions,
): Promise<Memory[]> {
  const { query, queryEmbedding: precomputed, currentUserId, limit = 20, minRelevanceScore = 0.1 } = options;
  const start = Date.now();

  try {
    const [queryEmbedding, lexemes] = await Promise.all([
      precomputed ? Promise.resolve(precomputed) : embedText(query),
      extractLexemes(query),
    ]);

    const CANDIDATE_POOL_SIZE = Math.max(25, limit);
    const embeddingLiteral = JSON.stringify(queryEmbedding);

    const privacyFilter = sql`(
      ${memories.sourceChannelType} != 'dm'
      OR ${memories.shareable} = 1
      OR ${memories.relatedUserIds} @> ARRAY[${currentUserId}]::text[]
    )`;

    const baseFilter = sql`${memories.embedding} IS NOT NULL AND ${memories.relevanceScore} >= ${minRelevanceScore}`;

    logger.debug(`Extracted ${lexemes.length} lexemes for fulltext search`, {
      lexemes,
      query: query.substring(0, 100),
    });

    const fulltextSearchCte = lexemes.length === 0
      ? sql`
        fulltext_search AS (
          SELECT NULL::uuid AS id, NULL::bigint AS rank
          WHERE FALSE
        )
      `
      : (() => {
        const perTermCtes = lexemes.map((lexeme, index) => {
          const cteName = sql.raw(`ft_${index}`);
          return sql`
            ${cteName} AS (
              SELECT id, ROW_NUMBER() OVER (
                ORDER BY ts_rank_cd(search_vector, to_tsquery('english', ${lexeme}), 4) DESC
              ) AS rank
              FROM memories
              WHERE search_vector @@ to_tsquery('english', ${lexeme})
                AND ${baseFilter}
                AND ${privacyFilter}
              ORDER BY ts_rank_cd(search_vector, to_tsquery('english', ${lexeme}), 4) DESC
              LIMIT ${PER_TERM_FULLTEXT_LIMIT}
            )
          `;
        });

        const unionParts = sql.join(
          lexemes.map((_, index) => sql.raw(`SELECT * FROM ft_${index}`)),
          sql` UNION ALL `,
        );

        return sql`
          ${sql.join(perTermCtes, sql`, `)},
          ft_dedup AS (
            SELECT id, MIN(rank) AS rank
            FROM (${unionParts}) all_terms
            GROUP BY id
          ),
          fulltext_search AS (
            SELECT id, rank
            FROM ft_dedup
          )
        `;
      })();

    const hybridQuery = sql`
      WITH vector_search AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> ${embeddingLiteral}::vector) AS rank
        FROM memories
        WHERE ${baseFilter} AND ${privacyFilter}
        ORDER BY embedding <=> ${embeddingLiteral}::vector
        LIMIT ${CANDIDATE_POOL_SIZE}
      ),
      ${fulltextSearchCte}
      SELECT
        m.*,
        COALESCE(rrf_score(v.rank), 0.0) + COALESCE(rrf_score(f.rank), 0.0) AS rrf_score,
        (1 - (m.embedding <=> ${embeddingLiteral}::vector)) AS similarity
      FROM (
        SELECT COALESCE(v.id, f.id) AS id, v.rank AS vector_rank, f.rank AS fulltext_rank
        FROM vector_search v
        FULL OUTER JOIN fulltext_search f ON v.id = f.id
      ) fused
      JOIN memories m ON m.id = fused.id
      LEFT JOIN vector_search v ON v.id = fused.id
      LEFT JOIN fulltext_search f ON f.id = fused.id
      ORDER BY rrf_score DESC
    `;

    const executeResult = await db.execute(hybridQuery);
    const rawResults = ((executeResult as any).rows ?? executeResult) as Array<Record<string, any>>;

    if (rawResults.length === 0) {
      logger.info(`No memory candidates found in ${Date.now() - start}ms`);
      return [];
    }

    // NOTE: manual mapping required because hybrid SQL CTEs bypass Drizzle's auto-mapping.
    // If the memories schema changes, update this mapping to match.
    const results = rawResults.map((row) => ({
      memory: {
        id: row.id,
        content: row.content,
        type: row.type,
        sourceMessageId: row.source_message_id ?? null,
        sourceChannelType: row.source_channel_type,
        relatedUserIds: row.related_user_ids ?? [],
        embedding: row.embedding,
        relevanceScore: row.relevance_score ?? 1,
        shareable: row.shareable ?? 0,
        searchVector: row.search_vector ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } as Memory,
      similarity: Number(row.similarity ?? 0),
      rrfScore: Number(row.rrf_score ?? 0),
    }));

    const rerankingModel = await getRerankingModel();
    const now = Date.now();
    let topMemories: Memory[];

    if (rerankingModel && results.length > 0) {
      const documents = results.map((r) => r.memory.content);

      const { ranking } = await rerank({
        model: rerankingModel,
        query,
        documents,
        topN: results.length,
      });

      const scored = ranking.map((item) => {
        const memory = results[item.originalIndex].memory;
        const ageMs = now - new Date(memory.createdAt).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const recencyBoost = Math.max(0, 1 - ageDays / 365);

        const score = item.score * 0.8 + recencyBoost * 0.2;
        return { memory, score };
      });

      scored.sort((a, b) => b.score - a.score);
      topMemories = scored.slice(0, limit).map((s) => s.memory);

      logger.info(
        `Retrieved ${topMemories.length} memories (hybrid+reranked) in ${Date.now() - start}ms`,
        {
          query: query.substring(0, 100),
          totalCandidates: results.length,
          lexemeCount: lexemes.length,
          method: "hybrid-rrf+cohere-rerank",
        },
      );
    } else {
      const RRF_K = 60;
      const maxRrfScore = 2 / (1 + RRF_K);

      const scored = results.map(({ memory, similarity, rrfScore }) => {
        const ageMs = now - new Date(memory.createdAt).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const recencyBoost = Math.max(0, 1 - ageDays / 365);

        const normalizedRrf = maxRrfScore > 0 ? rrfScore / maxRrfScore : 0;
        const score =
          normalizedRrf * 0.5 +
          similarity * 0.2 +
          memory.relevanceScore * 0.15 +
          recencyBoost * 0.15;

        return { memory, score };
      });

      scored.sort((a, b) => b.score - a.score);
      topMemories = scored.slice(0, limit).map((s) => s.memory);

      logger.info(
        `Retrieved ${topMemories.length} memories (hybrid+legacy scoring) in ${Date.now() - start}ms`,
        {
          query: query.substring(0, 100),
          totalCandidates: results.length,
          lexemeCount: lexemes.length,
          method: "hybrid-rrf+legacy",
        },
      );
    }

    return topMemories;
  } catch (error) {
    logger.error("Memory retrieval failed", {
      error: String(error),
      query: query.substring(0, 100),
    });
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
  /** Thread ts to exclude from results (e.g. the current thread, which is already in context) */
  excludeThreadTs?: string;
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
    excludeThreadTs,
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
    const threadMap = new Map<string, { channelId: string; bestSimilarity: number; mostRecentMessageAt: Date }>();
    for (const r of relevant) {
      const threadKey = r.message.slackThreadTs || r.message.slackTs;
      const messageDate = new Date(r.message.createdAt);
      const existing = threadMap.get(threadKey);
      if (!existing) {
        threadMap.set(threadKey, {
          channelId: r.message.channelId,
          bestSimilarity: r.similarity,
          mostRecentMessageAt: messageDate,
        });
      } else {
        if (r.similarity > existing.bestSimilarity) {
          existing.bestSimilarity = r.similarity;
          existing.channelId = r.message.channelId;
        }
        if (messageDate > existing.mostRecentMessageAt) {
          existing.mostRecentMessageAt = messageDate;
        }
      }
    }

    if (excludeThreadTs) {
      threadMap.delete(excludeThreadTs);
    }

    // Score threads: combine cosine similarity with recency boost
    const now = Date.now();
    const sortedThreads = [...threadMap.entries()]
      .map(([key, meta]) => {
        const ageDays = (now - meta.mostRecentMessageAt.getTime()) / (1000 * 60 * 60 * 24);
        const recencyBoost = Math.max(0, 1 - ageDays / 30);
        const combinedScore = meta.bestSimilarity * 0.8 + recencyBoost * 0.2;
        return [key, { ...meta, combinedScore }] as const;
      })
      .sort((a, b) => b[1].combinedScore - a[1].combinedScore)
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

import { sql } from "drizzle-orm";
import { rerank } from "ai";
import { db } from "../db/client.js";
import { memories, messages, type Memory } from "@aura/db/schema";
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
  /** Skip privacy filter (for admin dashboard) */
  adminMode?: boolean;
  /** Workspace ID for tenant isolation in entity queries */
  workspaceId?: string;
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
 * Entity-first retrieval: resolve entity names from the query via alias matching,
 * then fetch their linked memories.
 */
async function fetchEntityMatchedMemories(
  query: string,
  minRelevanceScore: number,
  currentUserId?: string,
  workspaceId?: string,
): Promise<Memory[]> {
  try {
    const words = query.split(/[\s,;]+/).filter((w) => w.length > 1);
    if (words.length === 0) return [];

    const candidates: string[] = [];
    for (const w of words) {
      if (w.length >= 3 && /^[A-Z]/.test(w)) candidates.push(w);
    }
    for (let i = 0; i < words.length - 1; i++) {
      if (/^[A-Z]/.test(words[i]) && /^[A-Z]/.test(words[i + 1])) {
        candidates.push(`${words[i]} ${words[i + 1]}`);
      }
    }
    for (let i = 0; i < words.length - 2; i++) {
      if (/^[A-Z]/.test(words[i]) && /^[A-Z]/.test(words[i + 1]) && /^[A-Z]/.test(words[i + 2])) {
        candidates.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
      }
    }
    if (query.trim().length > 2) candidates.push(query.trim());

    if (candidates.length === 0) return [];

    const lowerCandidates = candidates.slice(0, 10).map((c) => c.toLowerCase());
    const workspaceFilter = workspaceId ? sql`AND e.workspace_id = ${workspaceId}` : sql``;

    const matchResult = await db.execute(sql`
      SELECT DISTINCT e.id
      FROM entities e
      JOIN entity_aliases ea ON e.id = ea.entity_id
      WHERE (
        ea.alias_lower = ANY(${lowerCandidates})
        OR (
          ea.alias_lower % ANY(${lowerCandidates})
          AND EXISTS (
            SELECT 1 FROM unnest(${lowerCandidates}::text[]) AS c(val)
            WHERE similarity(ea.alias_lower, c.val) > 0.5
          )
        )
      )
      ${workspaceFilter}
    `);
    const matchRows = ((matchResult as any).rows ?? matchResult) as Array<{ id: string }>;
    const entityIds = matchRows.map((row) => row.id);

    if (entityIds.length === 0) return [];

    const privacyFilter = currentUserId
      ? sql`AND (
          m.source_channel_type != 'dm'
          OR m.shareable = 1
          OR m.related_user_ids @> ARRAY[${currentUserId}]::text[]
        )`
      : sql``;

    const workspaceMemoryFilter = workspaceId ? sql`AND m.workspace_id = ${workspaceId}` : sql``;

    const memoryResult = await db.execute(sql`
      SELECT DISTINCT m.*
      FROM memories m
      JOIN memory_entities me ON m.id = me.memory_id
      WHERE me.entity_id = ANY(${entityIds})
        AND m.relevance_score >= ${minRelevanceScore}
        ${privacyFilter}
        ${workspaceMemoryFilter}
      ORDER BY m.relevance_score DESC, m.created_at DESC
      LIMIT 50
    `);

    const rows = ((memoryResult as any).rows ?? memoryResult) as Array<Record<string, any>>;
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
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
    })) as Memory[];
  } catch (error) {
    logger.warn("Entity-first retrieval failed, falling back to hybrid search only", {
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
 * 0. Entity-first retrieval: resolve entity names from the query via aliases, fetch linked memories
 * 1. Embed the user's message
 * 2. Extract up to 8 positional lexemes from Postgres full-text parsing
 * 3. Run hybrid SQL: pgvector + per-term full-text lanes merged by best rank
 * 4. Fuse results via Reciprocal Rank Fusion (RRF) with FULL OUTER JOIN
 * 5. Merge entity-matched + hybrid results, apply entity boost
 * 6. Rerank top candidates with Cohere (or fall back to legacy scoring)
 * 7. Return top-K memories
 */
export async function retrieveMemories(
  options: RetrievalOptions,
): Promise<Memory[]> {
  const { query, queryEmbedding: precomputed, currentUserId, limit = 20, minRelevanceScore = 0.1, adminMode = false, workspaceId } = options;
  const start = Date.now();

  try {
    const [queryEmbedding, lexemes, entityMemories] = await Promise.all([
      precomputed ? Promise.resolve(precomputed) : embedText(query),
      extractLexemes(query),
      fetchEntityMatchedMemories(query, minRelevanceScore, adminMode ? undefined : currentUserId, workspaceId),
    ]);

    const CANDIDATE_POOL_SIZE = Math.max(25, limit);
    // Embed vector as a raw SQL literal instead of a parameterized value.
    // This avoids Drizzle/Neon driver issues with large string params that
    // look like arrays. Safe because validateEmbedding() guarantees all
    // values are finite numbers.
    const vectorSql = sql.raw(`'[${queryEmbedding.join(",")}]'::vector`);

    const privacyFilter = adminMode
      ? sql`TRUE`
      : sql`(
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
        SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> ${vectorSql}) AS rank
        FROM memories
        WHERE ${baseFilter} AND ${privacyFilter}
        ORDER BY embedding <=> ${vectorSql}
        LIMIT ${CANDIDATE_POOL_SIZE}
      ),
      ${fulltextSearchCte}
      SELECT
        m.*,
        COALESCE(rrf_score(v.rank), 0.0) + COALESCE(rrf_score(f.rank), 0.0) AS rrf_score,
        (1 - (m.embedding <=> ${vectorSql})) AS similarity
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

    if (rawResults.length === 0 && entityMemories.length === 0) {
      logger.info(`No memory candidates found in ${Date.now() - start}ms`);
      return [];
    }

    // NOTE: manual mapping required because hybrid SQL CTEs bypass Drizzle's auto-mapping.
    // If the memories schema changes, update this mapping to match.
    const hybridResults = rawResults.map((row) => ({
      memory: {
        id: row.id,
        workspaceId: row.workspace_id,
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

    // Merge entity-matched memories with high base RRF score so they rank above embedding-only matches
    const ENTITY_RRF_BOOST = 0.05;
    const hybridIds = new Set(hybridResults.map((r) => r.memory.id));
    const entityOnlyMemories = entityMemories
      .filter((m) => !hybridIds.has(m.id))
      .map((m) => ({
        memory: m,
        similarity: 0,
        rrfScore: ENTITY_RRF_BOOST,
      }));

    // Boost hybrid results that also have entity matches
    const entityMatchedIds = new Set(entityMemories.map((m) => m.id));
    for (const r of hybridResults) {
      if (entityMatchedIds.has(r.memory.id)) {
        r.rrfScore += ENTITY_RRF_BOOST;
      }
    }

    const results = [...hybridResults, ...entityOnlyMemories];

    if (entityMemories.length > 0) {
      logger.debug(`Entity-first retrieval found ${entityMemories.length} memories, ${entityOnlyMemories.length} unique`, {
        query: query.substring(0, 100),
      });
    }

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
        return { memory, score, originalIndex: item.originalIndex, cohereScore: item.score };
      });

      scored.sort((a, b) => b.score - a.score);
      topMemories = scored.slice(0, limit).map((s) => s.memory);

      logger.info(
        `Reranked ${results.length} memories → top ${topMemories.length} in ${Date.now() - start}ms`,
        {
          query: query.substring(0, 100),
          totalCandidates: results.length,
          lexemeCount: lexemes.length,
          method: "hybrid-rrf+cohere-rerank",
        },
      );
      const reranking = scored.slice(0, limit).map((s, newRank) =>
        `${s.originalIndex + 1} → ${newRank + 1} (cohere=${s.cohereScore.toFixed(3)}, final=${s.score.toFixed(3)})`
      ).join(", ");
      logger.debug(`Reranking details: ${reranking}`);
    } else {
      const RRF_K = 60;
      const maxRrfScore = 2 / (1 + RRF_K);

      const scored = results.map(({ memory, similarity, rrfScore }) => {
        const ageMs = now - new Date(memory.createdAt).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const recencyBoost = Math.max(0, 1 - ageDays / 365);

        const normalizedRrf = maxRrfScore > 0 ? Math.min(rrfScore / maxRrfScore, 1) : 0;
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
  } catch (error: any) {
    logger.error("Memory retrieval failed", {
      error: error?.message ?? String(error),
      code: error?.code,
      cause: error?.cause ? String(error.cause) : undefined,
      query: query.substring(0, 100),
    });
    throw error;
  }
}

// ── Conversation-level retrieval ─────────────────────────────────────────────

export interface ConversationThread {
  /** The thread identifier (slack_thread_ts of the root message) */
  threadTs: string;
  /** Channel where the conversation happened */
  channelId: string;
  /** Best similarity score among matched messages in this thread */
  bestSimilarity: number;
  /** ISO date (YYYY-MM-DD) of the thread */
  date: string;
  /** First user message text, truncated to ~100 chars */
  summary: string;
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
 * Retrieve compact conversation thread pointers via semantic search on message embeddings.
 *
 * Returns thread metadata + a short summary (first user message) instead of
 * full message dumps, keeping the system prompt compact.
 *
 * Flow:
 * 1. Embed the query
 * 2. Find the most similar messages via pgvector
 * 3. Group matched messages by thread (slack_thread_ts)
 * 4. Fetch the first user message per thread for a summary
 * 5. Return compact thread pointers sorted by best match score
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
    const vectorSql = sql.raw(`'[${queryEmbedding.join(",")}]'::vector`);

    // Find the most similar messages
    const matchedMessages = await db
      .select({
        message: messages,
        similarity: sql<number>`1 - (${messages.embedding} <=> ${vectorSql})`.as("similarity"),
      })
      .from(messages)
      .where(sql`${messages.embedding} IS NOT NULL`)
      .orderBy(sql`${messages.embedding} <=> ${vectorSql}`)
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
      if (!threadKey) continue;
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

    // Fetch only the first user message per thread for a compact summary
    // DISTINCT ON returns exactly one row per thread, prioritising user messages
    const threadKeys = sortedThreads.map(([key]) => key);
    const threadKeysList = sql.join(threadKeys.map(k => sql`${k}`), sql`, `);
    const summaryResult = await db.execute(sql`
      SELECT DISTINCT ON (COALESCE(slack_thread_ts, slack_ts))
        slack_ts, slack_thread_ts, content, role, created_at
      FROM messages
      WHERE slack_thread_ts IN (${threadKeysList}) OR slack_ts IN (${threadKeysList})
      ORDER BY COALESCE(slack_thread_ts, slack_ts),
               (CASE WHEN role = 'user' THEN 0 ELSE 1 END),
               created_at
    `);
    const summaryRows = ((summaryResult as any).rows ?? summaryResult) as Array<Record<string, any>>;

    const threadSummaryMap = new Map<string, { content: string; date: string }>();
    for (const m of summaryRows) {
      const key = (m.slack_thread_ts || m.slack_ts) as string;
      if (!key) continue;
      const rawContent = m.content as string;
      const content = rawContent.length > 100 ? rawContent.substring(0, 100) + "…" : rawContent;
      const date = new Date(m.created_at).toISOString().split("T")[0];
      threadSummaryMap.set(key, { content, date });
    }

    const conversationThreads: ConversationThread[] = sortedThreads.map(
      ([threadTs, meta]) => {
        const summaryData = threadSummaryMap.get(threadTs);
        return {
          threadTs,
          channelId: meta.channelId,
          bestSimilarity: meta.bestSimilarity,
          date: summaryData?.date ?? new Date(meta.mostRecentMessageAt).toISOString().split("T")[0],
          summary: summaryData?.content ?? "",
        };
      },
    );

    logger.info(
      `Retrieved ${conversationThreads.length} conversation threads (${relevant.length} matched messages) in ${Date.now() - start}ms`,
      { query: query.substring(0, 100) },
    );

    return conversationThreads;
  } catch (error: any) {
    logger.error("Conversation retrieval failed", {
      error: error?.message ?? String(error),
      code: error?.code,
      cause: error?.cause ? String(error.cause) : undefined,
      query: query.substring(0, 100),
    });
    return [];
  }
}

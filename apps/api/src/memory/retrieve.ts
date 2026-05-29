import { sql } from "drizzle-orm";
import { generateObject, rerank as rerankMemories } from "ai";
import { z } from "zod";
import { db } from "../db/client.js";
import { messages, type Memory } from "@aura/db/schema";
import type { EntityType } from "@aura/db/schema";
import { embedText } from "../lib/embeddings.js";
import { getFastModel, getRerankingModel } from "../lib/ai.js";
import { resolveEntityReadOnly } from "./entity-resolution.js";
import { logger } from "../lib/logger.js";

interface RetrievalOptions {
  /** The user's current message text */
  query: string;
  /** Pre-computed query embedding (avoids double-embedding when called alongside retrieveConversations) */
  queryEmbedding?: number[];
  /** The Slack user ID of the person asking */
  currentUserId: string;
  /** Slack channel/conversation where the query is happening, used for DM privacy and channel weighting */
  channelId?: string;
  /** Slack channel type for the current query context */
  channelType?: string;
  /** Maximum number of memories to return */
  limit?: number;
  /** Minimum relevance score threshold */
  minRelevanceScore?: number;
  /** Skip privacy filter (for admin dashboard) */
  adminMode?: boolean;
  /** Workspace ID for tenant isolation in entity queries */
  workspaceId?: string;
  /**
   * Bi-temporal "as-of" instant. When set, retrieval returns the memories that
   * were valid at this point in time — `valid_from <= asOf AND (valid_until IS
   * NULL OR valid_until > asOf)` — instead of the live `status IN
   * ('current','disputed')` pool. A memory superseded/archived AFTER `asOf` is
   * still included (it was current then); one closed out at or before `asOf` is
   * excluded. This is what makes the memory bench's timeline deterministic when
   * extraction races ahead of scoring. Production passes nothing — live status
   * filtering is unchanged.
   */
  asOf?: Date;
  /**
   * Optional cost hook. When set, the query-entity-extraction LLM call reports
   * its model id + token usage so callers (e.g. the bench cost meter) can price
   * retrieval. Production passes nothing — no behaviour change.
   */
  onUsage?: (
    modelId: string,
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    },
  ) => void;
  /** Restrict cosine/full-text candidates to resolved entities + a recent tail. Defaults on. */
  prefilter?: boolean;
  /**
   * Apply a Cohere rerank pass and use its relevance score as the semantic
   * signal in the fusion ranker. Off by default — score fusion (#1054) is the
   * default ranker; Cohere is now opt-in, not the default.
   */
  rerank?: boolean;
}

const MAX_FULLTEXT_LEXEMES = 8;
const PER_TERM_FULLTEXT_LIMIT = 25;
const ENTITY_PREFILTER_RECENT_TAIL_LIMIT = 50;

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

// ── LLM-based entity extraction ─────────────────────────────────────────────

const queryEntitySchema = z.object({
  entities: z.array(z.object({
    name: z.string().describe("The entity name as mentioned or implied"),
    type: z.enum(["person", "company", "project", "product", "channel", "technology", "concept", "location"]),
  })),
});

async function extractQueryEntities(
  query: string,
  onUsage?: RetrievalOptions["onUsage"],
): Promise<Array<{ name: string; type: EntityType }>> {
  try {
    const model = await getFastModel();
    const { object, usage } = await generateObject({
      model,
      schema: queryEntitySchema,
      prompt: `Extract entity mentions from this message. Include explicitly named entities and strongly implied ones. Be conservative — only extract entities you're confident about.

Entity types: person, company, project, product, channel, technology, concept, location

Message: "${query}"`,
      temperature: 0,
    });
    onUsage?.((model as any)?.modelId ?? "retrieve", usage);
    return object.entities;
  } catch (error) {
    logger.warn("Query entity extraction failed, falling back to heuristic", {
      error: String(error),
      query: query.substring(0, 100),
    });
    return [];
  }
}

// ── Heuristic proper noun extraction (fallback) ─────────────────────────────

function extractEntitiesHeuristic(query: string): string[] {
  const words = query.split(/[\s,;]+/).map((w) => w.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")).filter((w) => w.length > 1);
  if (words.length === 0) return [];

  const STOP_WORDS = new Set([
    "what", "when", "where", "which", "who", "whom", "whose", "why", "how",
    "tell", "show", "find", "get", "give", "let", "make", "can", "could",
    "would", "should", "will", "does", "did", "has", "have", "had", "are",
    "is", "was", "were", "been", "being", "the", "this", "that", "these",
    "those", "there", "here", "not", "but", "and", "for", "with", "about",
    "from", "into", "any", "all", "also", "just", "than", "then", "now",
    "very", "its", "his", "her", "our", "your", "their", "some", "each",
    "every", "both", "few", "more", "most", "other", "many", "much", "own",
    "same", "such", "only", "new", "old", "well", "also", "back", "even",
    "still", "after", "before", "between", "under", "over", "again",
    "further", "once", "during", "while", "please", "thanks", "thank",
    "know", "think", "want", "need", "like", "look", "use", "say", "said",
  ]);
  const isProperNoun = (w: string, idx: number) =>
    /^[A-Z]/.test(w) && !STOP_WORDS.has(w.toLowerCase()) && (idx > 0 || /^[A-Z]{2,}/.test(w) || words.length === 1);

  const candidates: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i].length >= 3 && isProperNoun(words[i], i)) candidates.push(words[i]);
  }
  for (let i = 0; i < words.length - 1; i++) {
    if (isProperNoun(words[i], i) && isProperNoun(words[i + 1], i + 1)) {
      candidates.push(`${words[i]} ${words[i + 1]}`);
    }
  }
  for (let i = 0; i < words.length - 2; i++) {
    if (isProperNoun(words[i], i) && isProperNoun(words[i + 1], i + 1) && isProperNoun(words[i + 2], i + 2)) {
      candidates.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
  }

  return [...new Set(candidates.slice(0, 10))];
}

// ── Entity-first memory retrieval result with per-entity tracking ───────────

interface EntityMemoryResult {
  memories: Memory[];
  /** Maps memory ID → set of resolved entity IDs it was found through */
  memoryEntityMap: Map<string, Set<string>>;
  /** Total number of distinct entities resolved */
  resolvedEntityCount: number;
  /** Distinct resolved entity IDs, used to pre-filter the hybrid candidate pool */
  resolvedEntityIds: string[];
}

interface MemoryVisibilityOptions {
  adminMode: boolean;
  currentUserId: string;
  channelId?: string;
}

function memoryColumn(columnName: string, tableAlias?: string) {
  return sql.raw(tableAlias ? `${tableAlias}.${columnName}` : columnName);
}

function buildMemoryVisibilityFilter(
  options: MemoryVisibilityOptions,
  tableAlias?: string,
) {
  if (options.adminMode) return sql`TRUE`;

  const sourceChannelType = memoryColumn("source_channel_type", tableAlias);
  const sourceChannelId = memoryColumn("source_channel_id", tableAlias);
  const shareable = memoryColumn("shareable", tableAlias);
  const relatedUserIds = memoryColumn("related_user_ids", tableAlias);
  const sameDmPrivateMemory = options.channelId
    ? sql`(
        ${sourceChannelType} = 'dm'
        AND ${sourceChannelId} = ${options.channelId}
        AND ${relatedUserIds} @> ARRAY[${options.currentUserId}]::text[]
      )`
    : sql`FALSE`;

  return sql`(
    ${sourceChannelType} != 'dm'
    OR ${shareable} = 1
    OR ${sameDmPrivateMemory}
  )`;
}

function buildMemoryBaseFilter(
  minRelevanceScore: number,
  workspaceId?: string,
  tableAlias?: string,
  requireEmbedding = true,
  asOf?: Date,
) {
  const embedding = memoryColumn("embedding", tableAlias);
  const relevanceScore = memoryColumn("relevance_score", tableAlias);
  const status = memoryColumn("status", tableAlias);
  const validFrom = memoryColumn("valid_from", tableAlias);
  const validUntil = memoryColumn("valid_until", tableAlias);
  const workspace = memoryColumn("workspace_id", tableAlias);
  const workspaceFilter = workspaceId
    ? sql`${workspace} = ${workspaceId}`
    : sql`TRUE`;

  const embeddingFilter = requireEmbedding ? sql`${embedding} IS NOT NULL` : sql`TRUE`;

  // As-of (bench): temporal validity replaces the live status filter so a
  // question sees the exact memory state at its instant on the timeline.
  // Production (no asOf) keeps the live status filter.
  const lifecycleFilter = asOf
    ? sql`${validFrom} <= ${asOf} AND (${validUntil} IS NULL OR ${validUntil} > ${asOf})`
    : sql`${status} IN ('current', 'disputed')`;

  return sql`${embeddingFilter}
    AND ${relevanceScore} >= ${minRelevanceScore}
    AND ${lifecycleFilter}
    AND ${workspaceFilter}`;
}

/**
 * Entity-first retrieval: extract entity names from query via LLM (with heuristic fallback),
 * resolve to entity IDs, then fetch their linked memories.
 */
async function fetchEntityMatchedMemories(
  query: string,
  minRelevanceScore: number,
  visibility: MemoryVisibilityOptions,
  workspaceId?: string,
  onUsage?: RetrievalOptions["onUsage"],
  asOf?: Date,
): Promise<EntityMemoryResult> {
  const emptyResult: EntityMemoryResult = {
    memories: [],
    memoryEntityMap: new Map(),
    resolvedEntityCount: 0,
    resolvedEntityIds: [],
  };

  try {
    // Step 1: Extract entities via LLM
    let extractedEntities = await extractQueryEntities(query, onUsage);

    // Step 2: Fall back to heuristic if LLM returns empty
    let usedHeuristic = false;
    if (extractedEntities.length === 0) {
      const heuristicNames = extractEntitiesHeuristic(query);
      if (heuristicNames.length === 0) return emptyResult;
      extractedEntities = heuristicNames.map((name) => ({ name, type: "company" as EntityType }));
      usedHeuristic = true;
    }

    if (!workspaceId) return emptyResult;

    // Step 3: Resolve each extracted entity to an entity ID (read-only, no creation)
    const resolutions = await Promise.all(
      extractedEntities.map(async (entity) => {
        const resolved = await resolveEntityReadOnly(entity.name, entity.type, workspaceId);
        return resolved ? { entityId: resolved.entityId, name: entity.name } : null;
      }),
    );
    const resolvedByEntity = resolutions.filter((r): r is NonNullable<typeof r> => r !== null);

    // If LLM entities resolved nothing, try heuristic as a second chance
    if (resolvedByEntity.length === 0 && !usedHeuristic) {
      const heuristicNames = extractEntitiesHeuristic(query);
      const heuristicResolutions = await Promise.all(
        heuristicNames.map(async (name) => {
          const resolved = await resolveEntityReadOnly(name, "company" as EntityType, workspaceId);
          return resolved ? { entityId: resolved.entityId, name } : null;
        }),
      );
      resolvedByEntity.push(...heuristicResolutions.filter((r): r is NonNullable<typeof r> => r !== null));
    }

    if (resolvedByEntity.length === 0) return emptyResult;

    const entityIds = [...new Set(resolvedByEntity.map((r) => r.entityId))];

    logger.debug("Entity resolution for retrieval", {
      extracted: extractedEntities.length,
      resolved: entityIds.length,
      usedHeuristic,
      query: query.substring(0, 100),
    });

    // Step 4: Fetch memories linked to resolved entities, tracking which entity each memory came from
    const visibilityFilter = buildMemoryVisibilityFilter(visibility, "m");
    const memoryBaseFilter = buildMemoryBaseFilter(minRelevanceScore, workspaceId, "m", false, asOf);

    const entityIdList = sql.join(entityIds.map(id => sql`${id}`), sql`, `);

    const memoryResult = await db.execute(sql`
      SELECT DISTINCT m.*
      FROM memories m
      JOIN memory_entities me ON m.id = me.memory_id
      WHERE me.entity_id IN (${entityIdList})
        AND ${memoryBaseFilter}
        AND ${visibilityFilter}
      ORDER BY m.relevance_score DESC, m.created_at DESC
      LIMIT 50
    `);

    const rows = ((memoryResult as any).rows ?? memoryResult) as Array<Record<string, any>>;
    const memoryIds = rows.map((r) => r.id as string);

    // Restrict entity map to only the candidate memory IDs to avoid unbounded result sets
    const memoryIdList = sql.join(memoryIds.map(id => sql`${id}`), sql`, `);
    const entityMapResult = memoryIds.length > 0
      ? await db.execute(sql`
          SELECT me.memory_id, me.entity_id
          FROM memory_entities me
          WHERE me.entity_id IN (${entityIdList})
            AND me.memory_id IN (${memoryIdList})
        `)
      : [];
    const entityMapRows = ((entityMapResult as any).rows ?? entityMapResult) as Array<Record<string, any>>;

    const memoryEntityMap = new Map<string, Set<string>>();
    for (const row of entityMapRows) {
      const memoryId = row.memory_id as string;
      const entityId = row.entity_id as string;
      if (!memoryEntityMap.has(memoryId)) {
        memoryEntityMap.set(memoryId, new Set());
      }
      memoryEntityMap.get(memoryId)!.add(entityId);
    }

    const memoriesList: Memory[] = rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      content: row.content,
      type: row.type,
      sourceMessageId: row.source_message_id ?? null,
      sourceChannelType: row.source_channel_type,
      sourceThreadTs: row.source_thread_ts ?? null,
      sourceChannelId: row.source_channel_id ?? null,
      relatedUserIds: row.related_user_ids ?? [],
      embedding: row.embedding,
      relevanceScore: row.relevance_score ?? 1,
      shareable: row.shareable ?? 0,
      searchVector: row.search_vector ?? null,
      status: row.status ?? "current",
      confidence: row.confidence ?? 0.8,
      validFrom: row.valid_from ?? null,
      validUntil: row.valid_until ?? null,
      supersedesMemoryId: row.supersedes_memory_id ?? null,
      supersededAt: row.superseded_at ?? null,
      supersededByMemoryId: row.superseded_by_memory_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } as Memory));

    return {
      memories: memoriesList,
      memoryEntityMap,
      resolvedEntityCount: entityIds.length,
      resolvedEntityIds: entityIds,
    };
  } catch (error) {
    logger.warn("Entity-first retrieval failed, falling back to hybrid search only", {
      error: String(error),
      query: query.substring(0, 100),
    });
    return emptyResult;
  }
}

/** A merged retrieval candidate carrying every raw fusion signal. */
interface FusionCandidate {
  memory: Memory;
  /** Cosine similarity (1 - distance); 0 for entity-only candidates. */
  similarity: number;
  /** Raw BM25 (ts_rank_cd) over the OR of query lexemes; 0 when none matched. */
  bm25: number;
  /** Fraction of resolved query entities this memory is linked to (0..1). */
  entityBoost: number;
  /** 1 when the memory's source channel equals the query channel. */
  channelBoost: number;
}

/**
 * Explicit score-fusion weights (#1054). Tuned against the bench; kept in one
 * object so a single edit + bench run re-tunes the ranker. Semantic dominates,
 * BM25 is the lexical anchor, entity + graph-link signals carry the multi-hop
 * coverage, and recency/relevance/channel are light tie-breakers.
 */
const FUSION_WEIGHTS = {
  semantic: 0.42,
  bm25: 0.18,
  entity: 0.15,
  link: 0.1,
  recency: 0.05,
  relevance: 0.05,
  channel: 0.05,
} as const;

/** Sigmoid shaping for raw BM25 (ts_rank_cd values cluster low and positive). */
const BM25_SIGMOID_SCALE = 12;
const BM25_SIGMOID_MID = 0.08;
/** How many top base-scoring candidates seed the graph-expansion (link) boost. */
const LINK_ANCHOR_COUNT = 5;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Min-max normalize to [0,1]; collapses to a clamp when the range is ~0. */
function minMaxNormalize(values: number[]): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (!Number.isFinite(range) || range < 1e-9) {
    return values.map((v) => Math.max(0, Math.min(1, v)));
  }
  return values.map((v) => (v - min) / range);
}

export interface FusionResult {
  memory: Memory;
  score: number;
}

/**
 * Fuse merged candidates into a single ranked list via explicit weighted score
 * fusion (#1054), replacing the old "RRF → Cohere-as-default" path.
 *
 * Signals: min-max-normalized cosine similarity (or a Cohere override),
 * sigmoid-normalized BM25, entity-match fraction, a graph-expansion boost
 * (candidates linked from the top base-scoring anchors — the multi-hop signal),
 * plus light recency / relevance / channel tie-breakers.
 */
export function fuseCandidates(
  candidates: FusionCandidate[],
  opts: { channelId?: string; now: number; semanticOverride?: number[] },
): FusionResult[] {
  if (candidates.length === 0) return [];
  const { channelId, now, semanticOverride } = opts;

  const semNorm = semanticOverride
    ? semanticOverride.map((v) => Math.max(0, Math.min(1, v)))
    : minMaxNormalize(candidates.map((c) => Math.max(0, c.similarity)));
  const bm25Norm = candidates.map((c) =>
    c.bm25 > 0 ? sigmoid(BM25_SIGMOID_SCALE * (c.bm25 - BM25_SIGMOID_MID)) : 0,
  );

  // Base score (no graph-link term) → pick anchors → union their linked ids.
  const baseScore = candidates.map(
    (c, i) =>
      FUSION_WEIGHTS.semantic * semNorm[i] +
      FUSION_WEIGHTS.bm25 * bm25Norm[i] +
      FUSION_WEIGHTS.entity * c.entityBoost,
  );
  const anchorIdx = candidates
    .map((_, i) => i)
    .sort((a, b) => baseScore[b] - baseScore[a])
    .slice(0, LINK_ANCHOR_COUNT);
  const linkedFromAnchors = new Set<string>();
  for (const i of anchorIdx) {
    for (const id of candidates[i].memory.linkedMemoryIds ?? []) {
      linkedFromAnchors.add(id);
    }
  }

  const channelWeight = channelId ? FUSION_WEIGHTS.channel : 0;

  const scored = candidates.map((c, i) => {
    const ageDays = (now - new Date(c.memory.createdAt).getTime()) / 86_400_000;
    const recency = Math.max(0, 1 - ageDays / 365);
    const linkBoost = linkedFromAnchors.has(c.memory.id) ? 1 : 0;

    const score =
      FUSION_WEIGHTS.semantic * semNorm[i] +
      FUSION_WEIGHTS.bm25 * bm25Norm[i] +
      FUSION_WEIGHTS.entity * c.entityBoost +
      FUSION_WEIGHTS.link * linkBoost +
      FUSION_WEIGHTS.recency * recency +
      FUSION_WEIGHTS.relevance * c.memory.relevanceScore +
      channelWeight * c.channelBoost;

    return { memory: c.memory, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Retrieve relevant memories using hybrid search (vector + full-text), merged
 * with entity-first retrieval, then ranked by explicit score fusion (#1054).
 *
 * Flow:
 * 0. Entity-first retrieval: resolve entity names from the query via aliases, fetch linked memories
 * 1. Embed the user's message
 * 2. Extract up to 8 positional lexemes from Postgres full-text parsing
 * 3. Run hybrid SQL: pgvector + per-term full-text lanes + raw BM25 + linked ids
 * 4. Merge entity-matched + hybrid results
 * 5. Score fusion: semantic + BM25 + entity + graph-link + recency/relevance/channel
 * 6. (optional) Cohere rerank override behind the `rerank` flag
 * 7. Return top-K memories
 */
export async function retrieveMemories(
  options: RetrievalOptions,
): Promise<Memory[]> {
  const {
    query,
    queryEmbedding: precomputed,
    currentUserId,
    channelId,
    channelType,
    limit = 20,
    minRelevanceScore = 0.1,
    adminMode = false,
    workspaceId,
    prefilter = true,
    rerank = false,
    onUsage,
    asOf,
  } = options;
  const start = Date.now();
  const visibility = { adminMode, currentUserId, channelId };

  try {
    const [queryEmbedding, lexemes, entityResult] = await Promise.all([
      precomputed ? Promise.resolve(precomputed) : embedText(query),
      extractLexemes(query),
      fetchEntityMatchedMemories(query, minRelevanceScore, visibility, workspaceId, onUsage, asOf),
    ]);
    const { memories: entityMemories, memoryEntityMap, resolvedEntityCount, resolvedEntityIds } = entityResult;

    const CANDIDATE_POOL_SIZE = Math.max(25, limit);
    // Embed vector as a raw SQL literal instead of a parameterized value.
    // This avoids Drizzle/Neon driver issues with large string params that
    // look like arrays. Safe because validateEmbedding() guarantees all
    // values are finite numbers.
    const vectorSql = sql.raw(`'[${queryEmbedding.join(",")}]'::vector`);

    const privacyFilter = buildMemoryVisibilityFilter(visibility);
    const baseFilter = buildMemoryBaseFilter(minRelevanceScore, workspaceId, undefined, true, asOf);
    const shouldPrefilterByEntity = prefilter && resolvedEntityIds.length > 0;
    const entityPrefilterIds = shouldPrefilterByEntity
      ? sql.join(resolvedEntityIds.map(id => sql`${id}`), sql`, `)
      : sql``;
    const candidatePoolCte = shouldPrefilterByEntity
      ? sql`
        candidate_pool AS (
          SELECT DISTINCT me.memory_id AS id
          FROM memory_entities me
          JOIN memories m ON m.id = me.memory_id
          WHERE me.entity_id IN (${entityPrefilterIds})
            AND ${buildMemoryBaseFilter(minRelevanceScore, workspaceId, "m", true, asOf)}
            AND ${buildMemoryVisibilityFilter(visibility, "m")}
          UNION
          SELECT id
          FROM (
            SELECT id
            FROM memories
            WHERE ${baseFilter} AND ${privacyFilter}
            ORDER BY created_at DESC
            LIMIT ${ENTITY_PREFILTER_RECENT_TAIL_LIMIT}
          ) recent_global_memories
        ),
      `
      : sql``;
    const candidatePoolFilter = shouldPrefilterByEntity
      ? sql`AND id IN (SELECT id FROM candidate_pool)`
      : sql``;
    const channelBoostSql = channelId
      ? sql`CASE WHEN m.source_channel_id = ${channelId} THEN 1.0 ELSE 0.0 END`
      : sql`0.0`;
    // Raw BM25 relevance over the OR of all query lexemes, surfaced so the
    // fusion ranker can sigmoid-normalize it (#1054). 0 when there are no
    // lexemes to match.
    const combinedTsQuery = lexemes.join(" | ");
    const bm25Sql = lexemes.length > 0
      ? sql`COALESCE(ts_rank_cd(m.search_vector, to_tsquery('english', ${combinedTsQuery}), 4), 0.0)`
      : sql`0.0`;

    logger.debug(`Extracted ${lexemes.length} lexemes for fulltext search`, {
      lexemes,
      query: query.substring(0, 100),
      prefilter: shouldPrefilterByEntity,
      resolvedEntityCount,
      channelType,
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
                ${candidatePoolFilter}
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
      WITH ${candidatePoolCte}
      vector_search AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> ${vectorSql}) AS rank
        FROM memories
        WHERE ${baseFilter} AND ${privacyFilter} ${candidatePoolFilter}
        ORDER BY embedding <=> ${vectorSql}
        LIMIT ${CANDIDATE_POOL_SIZE}
      ),
      ${fulltextSearchCte}
      SELECT
        m.*,
        COALESCE(rrf_score(v.rank), 0.0) + COALESCE(rrf_score(f.rank), 0.0) AS rrf_score,
        (1 - (m.embedding <=> ${vectorSql})) AS similarity,
        ${bm25Sql} AS bm25,
        ${channelBoostSql} AS channel_boost
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
        sourceThreadTs: row.source_thread_ts ?? null,
        sourceChannelId: row.source_channel_id ?? null,
        relatedUserIds: row.related_user_ids ?? [],
        linkedMemoryIds: row.linked_memory_ids ?? [],
        embedding: row.embedding,
        relevanceScore: row.relevance_score ?? 1,
        shareable: row.shareable ?? 0,
        searchVector: row.search_vector ?? null,
        status: row.status ?? "current",
        confidence: row.confidence ?? 0.8,
        validFrom: row.valid_from ?? null,
        validUntil: row.valid_until ?? null,
        supersedesMemoryId: row.supersedes_memory_id ?? null,
        supersededAt: row.superseded_at ?? null,
        supersededByMemoryId: row.superseded_by_memory_id ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } as Memory,
      similarity: Number(row.similarity ?? 0),
      rrfScore: Number(row.rrf_score ?? 0),
      bm25: Number(row.bm25 ?? 0),
      channelBoost: Number(row.channel_boost ?? 0),
    }));

    // Merge entity-matched memories; track entity boost as a separate signal
    // so it isn't lost to RRF normalization clamping or ignored in the reranker path.
    const ENTITY_RRF_BOOST = 0.05;
    const hybridIds = new Set(hybridResults.map((r) => r.memory.id));

    const entityBoostScore = (memoryId: string): number => {
      const linkedEntities = memoryEntityMap.get(memoryId);
      if (!linkedEntities) return 0;
      if (resolvedEntityCount <= 1) return 1;
      return Math.min(linkedEntities.size / resolvedEntityCount, 1);
    };

    const entityOnlyMemories = entityMemories
      .filter((m) => !hybridIds.has(m.id))
      .map((m) => ({
        memory: m,
        similarity: 0,
        rrfScore: ENTITY_RRF_BOOST,
        bm25: 0,
        entityBoost: entityBoostScore(m.id),
        channelBoost: channelId && m.sourceChannelId === channelId ? 1 : 0,
      }));

    const results = hybridResults.map((r) => ({
      ...r,
      entityBoost: entityBoostScore(r.memory.id),
    }));
    results.push(...entityOnlyMemories);

    if (entityMemories.length > 0) {
      logger.debug(`Entity-first retrieval found ${entityMemories.length} memories, ${entityOnlyMemories.length} unique`, {
        resolvedEntities: resolvedEntityCount,
        prefilter: shouldPrefilterByEntity,
        query: query.substring(0, 100),
      });
    }

    const now = Date.now();

    // Optional Cohere semantic override. Cohere is no longer the default ranker
    // (#1054) — fusion is. When `rerank` is requested and a model is available,
    // its relevance score replaces the cosine semantic signal in the fusion.
    let semanticOverride: number[] | undefined;
    if (rerank && results.length > 0) {
      const rerankingModel = await getRerankingModel();
      if (rerankingModel) {
        const { ranking } = await rerankMemories({
          model: rerankingModel,
          query,
          documents: results.map((r) => r.memory.content),
          topN: results.length,
        });
        semanticOverride = new Array<number>(results.length).fill(0);
        for (const item of ranking) semanticOverride[item.originalIndex] = item.score;
      }
    }

    const fused = fuseCandidates(results, {
      channelId,
      now,
      semanticOverride,
    });

    const topMemories = fused.slice(0, limit).map((f) => f.memory);

    logger.info(
      `Retrieved ${topMemories.length} memories (score-fusion${semanticOverride ? "+cohere" : ""}) in ${Date.now() - start}ms`,
      {
        query: query.substring(0, 100),
        totalCandidates: results.length,
        lexemeCount: lexemes.length,
        prefilter: shouldPrefilterByEntity,
        channelId,
        topScore: fused[0]?.score.toFixed(3),
        method: semanticOverride ? "score-fusion+cohere" : "score-fusion",
      },
    );

    return topMemories;
  } catch (error: any) {
    logger.error("Memory retrieval failed", {
      error: (error?.message ?? String(error)).slice(0, 200),
      code: error?.code,
      cause: error?.cause ? String(error.cause).slice(0, 200) : undefined,
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
  /** Workspace ID for tenant isolation. When provided, only messages in this workspace are searched. */
  workspaceId?: string;
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
    workspaceId,
  } = options;
  const start = Date.now();

  try {
    const queryEmbedding = precomputed ?? await embedText(query);
    const vectorSql = sql.raw(`'[${queryEmbedding.join(",")}]'::vector`);

    // Find the most similar messages
    const messagesWorkspaceFilter = workspaceId
      ? sql`AND ${messages.workspaceId} = ${workspaceId}`
      : sql``;
    const matchedMessages = await db
      .select({
        message: messages,
        similarity: sql<number>`1 - (${messages.embedding} <=> ${vectorSql})`.as("similarity"),
      })
      .from(messages)
      .where(sql`${messages.embedding} IS NOT NULL ${messagesWorkspaceFilter}`)
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
    const summaryWorkspaceFilter = workspaceId
      ? sql`AND workspace_id = ${workspaceId}`
      : sql``;
    const summaryResult = await db.execute(sql`
      SELECT DISTINCT ON (COALESCE(slack_thread_ts, slack_ts))
        slack_ts, slack_thread_ts, content, role, created_at
      FROM messages
      WHERE (slack_thread_ts IN (${threadKeysList}) OR slack_ts IN (${threadKeysList}))
        ${summaryWorkspaceFilter}
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

import { generateText, Output } from "ai";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories, type MemoryFactClass } from "@aura/db/schema";
import { getFastModel } from "../lib/ai.js";
import { aiTelemetry } from "../lib/langfuse.js";
import { logger } from "../lib/logger.js";
import { expiryFieldsForFactClass, isMemoryFactClass, MEMORY_FACT_CLASSES } from "./fact-class.js";
import { canSupersede, disputeMemory, supersedeMemory } from "./store.js";

/**
 * Nightly contradiction + class-assignment pass (#1557).
 *
 * Per-extraction contradiction only fires when a newer message is linked back
 * to an older one. Claims like "Claap access is broken" never get a "works now"
 * partner, so they sit current forever. This pass:
 *
 *  1. Clusters current/disputed memories by shared entity.
 *  2. Asks the extractor-class LLM to (a) assign volatile fact classes and
 *     (b) flag directly contradicting pairs.
 *  3. Applies class-based valid_until (never a type-level formula) and
 *     supersedes or disputes conflicting pairs under the same authority
 *     guard as live extraction.
 *
 * Retrieval already excludes `valid_until <= now()` rows; `archiveExpiredCurrentMemories`
 * then flips leftover current+expired rows to archived so the baseline
 * expired-but-current count drops to 0.
 */

export const CONTRADICTION_PROMPT = `You are a memory contradiction detector. Given a NEW memory and a list of EXISTING candidate memories, determine if any existing memory **directly contradicts** the new one.

A contradiction means: both memories are about the SAME entity/topic, but make OPPOSITE or MUTUALLY EXCLUSIVE claims.

Examples of contradictions:
- "Alice has read-only access to repo X" vs "Alice has full admin access to repo X"
- "The team uses PostgreSQL" vs "The team uses MongoDB"
- "Project Alpha launches in Q1" vs "Project Alpha launches in Q3"

NOT contradictions (do not flag these):
- Refinements: "Alice works on frontend" → "Alice works on frontend and backend" (addition, not conflict)
- Different topics: "Alice likes coffee" vs "Alice prefers Slack over email" (unrelated)
- Temporal updates: "Sprint 5 goal is X" → "Sprint 6 goal is Y" (different time periods)
- Complementary facts: "Bob manages 3 reports" vs "Bob's team is growing" (compatible)

Be CONSERVATIVE — only flag true contradictions where both facts cannot simultaneously be true.`;

export const contradictionResultSchema = z.object({
  results: z.array(
    z.object({
      candidateIndex: z.number().int().describe("0-based index of the candidate memory"),
      contradicts: z
        .boolean()
        .describe(
          "True only if the candidate makes a claim that directly conflicts with the new memory about the same entity/topic",
        ),
      reason: z.string().describe("Brief explanation of why this is or is not a contradiction"),
    }),
  ),
});

const CLUSTER_PROMPT = `You are reviewing CURRENT memories that all mention the same entity. Do two things:

1. Assign a volatile fact class when the memory is a claim that goes stale without an explicit correction. Leave factClass empty for durable facts (roles, preferences, decisions, personal details, historical incidents).
   Classes:
   - access: whether someone/something currently has access to a system/tool/resource
   - permissions: ACLs, grants, who can do what in a tool
   - pricing: current prices, plans, billing amounts
   - url: current URLs, endpoints, dashboard links
   - tool_status: whether a tool/integration is currently working, broken, or down

2. Flag pairs that DIRECTLY CONTRADICT each other (same topic, mutually exclusive claims). Be conservative — refinements, complementary facts, and different time periods are NOT contradictions.

Do not invent classes for durable facts. Do not flag a pair unless both claims cannot be true at once.`;

const clusterResultSchema = z.object({
  factClasses: z
    .array(
      z.object({
        index: z.number().int().describe("0-based index in the memory list"),
        factClass: z.enum(MEMORY_FACT_CLASSES),
      }),
    )
    .default([]),
  contradictions: z
    .array(
      z.object({
        aIndex: z.number().int(),
        bIndex: z.number().int(),
        reason: z.string(),
      }),
    )
    .default([]),
});

const MAX_CLUSTERS_PER_RUN = 30;
const MAX_MEMORIES_PER_CLUSTER = 12;
const TIME_BUDGET_MS = 8 * 60_000;

export interface EntityCluster {
  entityId: string;
  workspaceId: string;
  entityName: string;
  memoryCount: number;
}

export interface ClusterMemory {
  id: string;
  content: string;
  factClass: MemoryFactClass | null;
  validFrom: Date | null;
  validUntil: Date | null;
  createdAt: Date;
  sourceRole: string | null;
  status: string;
}

export async function archiveExpiredCurrentMemories(): Promise<number> {
  try {
    const result = await db.execute(sql`
      UPDATE memories
      SET status = 'archived',
          updated_at = NOW()
      WHERE status = 'current'
        AND valid_until IS NOT NULL
        AND valid_until <= NOW()
      RETURNING id
    `);
    const rows = ((result as { rows?: unknown[] }).rows ?? result) as unknown[];
    const count = Array.isArray(rows) ? rows.length : 0;
    if (count > 0) {
      logger.info("Archived expired-but-current memories", { count });
    }
    return count;
  } catch (error) {
    logger.error("Failed to archive expired current memories", { error: String(error) });
    throw error;
  }
}

export async function findEntityClusters(limit = MAX_CLUSTERS_PER_RUN): Promise<EntityCluster[]> {
  const result = await db.execute(sql`
    SELECT
      me.entity_id AS entity_id,
      m.workspace_id AS workspace_id,
      e.canonical_name AS entity_name,
      COUNT(*)::int AS memory_count,
      COUNT(*) FILTER (WHERE m.fact_class IS NOT NULL)::int AS classified_count
    FROM memories m
    JOIN memory_entities me ON me.memory_id = m.id
    JOIN entities e ON e.id = me.entity_id
    WHERE m.status IN ('current', 'disputed')
    GROUP BY me.entity_id, m.workspace_id, e.canonical_name
    HAVING COUNT(*) >= 2
    ORDER BY classified_count DESC, memory_count DESC
    LIMIT ${limit}
  `);
  const rows = ((result as { rows?: Array<Record<string, unknown>> }).rows ?? result) as Array<
    Record<string, unknown>
  >;
  return rows.map((row) => ({
    entityId: String(row.entity_id),
    workspaceId: String(row.workspace_id),
    entityName: String(row.entity_name ?? ""),
    memoryCount: Number(row.memory_count ?? 0),
  }));
}

export async function loadClusterMemories(
  entityId: string,
  workspaceId: string,
  limit = MAX_MEMORIES_PER_CLUSTER,
): Promise<ClusterMemory[]> {
  const result = await db.execute(sql`
    SELECT
      m.id,
      m.content,
      m.fact_class,
      m.valid_from,
      m.valid_until,
      m.created_at,
      m.extraction_source_role,
      m.status
    FROM memories m
    JOIN memory_entities me ON me.memory_id = m.id
    WHERE me.entity_id = ${entityId}::uuid
      AND m.workspace_id = ${workspaceId}
      AND m.status IN ('current', 'disputed')
    ORDER BY m.created_at DESC
    LIMIT ${limit}
  `);
  const rows = ((result as { rows?: Array<Record<string, unknown>> }).rows ?? result) as Array<
    Record<string, unknown>
  >;
  return rows.map((row) => ({
    id: String(row.id),
    content: String(row.content ?? ""),
    factClass: isMemoryFactClass(row.fact_class) ? row.fact_class : null,
    validFrom: row.valid_from ? new Date(String(row.valid_from)) : null,
    validUntil: row.valid_until ? new Date(String(row.valid_until)) : null,
    createdAt: new Date(String(row.created_at)),
    sourceRole: (row.extraction_source_role as string | null) ?? null,
    status: String(row.status ?? "current"),
  }));
}

export async function applyFactClassAssignment(
  memory: ClusterMemory,
  factClass: MemoryFactClass,
): Promise<boolean> {
  if (memory.factClass) return false;
  const validFrom = memory.validFrom ?? memory.createdAt;
  const fields = expiryFieldsForFactClass(factClass, validFrom);
  if (!("factClass" in fields)) return false;

  const updates: {
    factClass: MemoryFactClass;
    updatedAt: Date;
    validUntil?: Date;
  } = {
    factClass: fields.factClass,
    updatedAt: new Date(),
  };
  // Never overwrite a window already closed by supersession or extraction.
  if (!memory.validUntil) {
    updates.validUntil = fields.validUntil;
  }

  await db.update(memories).set(updates).where(eq(memories.id, memory.id));
  return true;
}

/**
 * Resolve a contradicting pair: recency wins when authority allows,
 * otherwise the lower-authority claim is disputed (same guard as live extraction).
 */
export async function resolveContradictingPair(
  a: ClusterMemory,
  b: ClusterMemory,
  reason: string,
): Promise<"superseded" | "disputed" | "skipped"> {
  const [newer, older] = a.createdAt.getTime() >= b.createdAt.getTime() ? [a, b] : [b, a];
  if (newer.id === older.id) return "skipped";

  if (canSupersede(newer.sourceRole, older.sourceRole)) {
    logger.info("Nightly contradiction — superseding older memory", {
      oldId: older.id,
      newId: newer.id,
      reason,
    });
    await supersedeMemory(older.id, newer.id);
    return "superseded";
  }

  logger.info("Nightly contradiction — disputing lower-authority claim", {
    disputedId: newer.id,
    keptId: older.id,
    reason,
  });
  await disputeMemory(
    newer.id,
    `nightly contradiction: conflicts with higher-authority memory ${older.id} (${reason})`,
  );
  return "disputed";
}

export interface NightlyContradictionResult {
  clusters: number;
  classified: number;
  superseded: number;
  disputed: number;
  archived: number;
}

export async function runNightlyContradictionPass(
  now = Date.now(),
): Promise<Omit<NightlyContradictionResult, "archived">> {
  const clusters = await findEntityClusters();
  const stats = { clusters: clusters.length, classified: 0, superseded: 0, disputed: 0 };
  if (clusters.length === 0) return stats;

  const model = await getFastModel();
  const seenPairs = new Set<string>();

  for (const cluster of clusters) {
    if (Date.now() - now > TIME_BUDGET_MS) {
      logger.info("Nightly contradiction pass hit time budget", stats);
      break;
    }

    const clusterMemories = await loadClusterMemories(cluster.entityId, cluster.workspaceId);
    if (clusterMemories.length < 2) continue;

    const listing = clusterMemories
      .map((m, i) => {
        const when = m.createdAt.toISOString().slice(0, 10);
        const role = m.sourceRole ?? "unknown";
        const cls = m.factClass ? ` class=${m.factClass}` : "";
        return `[${i}] (${when}, role=${role}${cls}) ${m.content}`;
      })
      .join("\n");

    try {
      const { output } = await generateText({
        model,
        output: Output.object({ schema: clusterResultSchema }),
        instructions: CLUSTER_PROMPT,
        prompt: `ENTITY: ${cluster.entityName}\n\nMEMORIES:\n${listing}`,
        telemetry: aiTelemetry("memory-nightly-contradiction"),
        temperature: 0,
      });

      for (const assignment of output.factClasses) {
        const memory = clusterMemories[assignment.index];
        if (!memory || !isMemoryFactClass(assignment.factClass)) continue;
        const applied = await applyFactClassAssignment(memory, assignment.factClass);
        if (applied) {
          memory.factClass = assignment.factClass;
          stats.classified++;
        }
      }

      for (const pair of output.contradictions) {
        const a = clusterMemories[pair.aIndex];
        const b = clusterMemories[pair.bIndex];
        if (!a || !b || a.id === b.id) continue;
        const key = [a.id, b.id].sort().join(":");
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const action = await resolveContradictingPair(a, b, pair.reason);
        if (action === "superseded") stats.superseded++;
        if (action === "disputed") stats.disputed++;
      }
    } catch (error) {
      logger.warn("Nightly contradiction LLM call failed — skipping cluster", {
        entityId: cluster.entityId,
        error: String(error).slice(0, 200),
      });
    }
  }

  logger.info("Nightly contradiction pass complete", stats);
  return stats;
}

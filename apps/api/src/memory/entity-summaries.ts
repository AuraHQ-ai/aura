import { generateObject } from "ai";
import { z } from "zod";
import { sql, eq, isNull, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { entities, memories, memoryEntities } from "@aura/db/schema";
import { getFastModel } from "../lib/ai.js";
import { logger } from "../lib/logger.js";

const MAX_MEMORIES_PER_ENTITY = 200;
const BATCH_SIZE = 10;
const DELAY_BETWEEN_CALLS_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a synthesized summary for a single entity from its linked memories.
 * Writes the result to entities.summary and sets summary_updated_at.
 */
export async function generateEntitySummary(
  entityId: string,
): Promise<string> {
  const entityRows = await db
    .select({
      id: entities.id,
      canonicalName: entities.canonicalName,
      type: entities.type,
    })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);

  const entity = entityRows[0];
  if (!entity) throw new Error(`Entity not found: ${entityId}`);

  type MemoryRow = { content: string; type: string; createdAt: Date };

  const linkedMemories: MemoryRow[] = await db
    .select({
      content: memories.content,
      type: memories.type,
      createdAt: memories.createdAt,
    })
    .from(memoryEntities)
    .innerJoin(memories, eq(memoryEntities.memoryId, memories.id))
    .where(eq(memoryEntities.entityId, entityId))
    .orderBy(sql`${memories.createdAt} DESC`)
    .limit(MAX_MEMORIES_PER_ENTITY);

  if (linkedMemories.length === 0) {
    return "";
  }

  const memoriesText = linkedMemories
    .map((m) => `- [${m.type}] ${m.content}`)
    .join("\n");

  const model = await getFastModel();

  const { object } = await generateObject({
    model,
    schema: z.object({ summary: z.string() }),
    system: `Synthesize a concise profile from these memories about ${entity.canonicalName} (${entity.type}). Focus on: what matters now, key decisions, relationships, current work. Discard trivial/operational noise. Max 200 words.`,
    prompt: memoriesText,
  });

  const now = new Date();
  await db
    .update(entities)
    .set({ summary: object.summary, summaryUpdatedAt: now })
    .where(eq(entities.id, entityId));

  return object.summary;
}

/**
 * Regenerate summaries for entities that are stale or have never been summarized.
 *
 * If forceAll is true, regenerates ALL entities with at least 1 linked memory.
 * Otherwise, finds entities where:
 *   (a) summary_updated_at IS NULL and they have linked memories, or
 *   (b) they have memories created after summary_updated_at
 */
export async function regenerateStaleSummaries(
  opts?: { forceAll?: boolean },
): Promise<{ updated: number; skipped: number }> {
  const forceAll = opts?.forceAll ?? false;

  type StaleRow = { id: string; canonical_name: string; type: string };

  let staleEntities: StaleRow[];

  if (forceAll) {
    staleEntities = (
      await db.execute(sql`
        SELECT DISTINCT e.id, e.canonical_name, e.type
        FROM entities e
        JOIN memory_entities me ON me.entity_id = e.id
        ORDER BY e.canonical_name
      `)
    ).rows as StaleRow[];
  } else {
    staleEntities = (
      await db.execute(sql`
        SELECT DISTINCT e.id, e.canonical_name, e.type
        FROM entities e
        JOIN memory_entities me ON me.entity_id = e.id
        WHERE e.summary_updated_at IS NULL
           OR e.summary_updated_at < (
             SELECT MAX(m.created_at)
             FROM memories m
             JOIN memory_entities me2 ON me2.memory_id = m.id
             WHERE me2.entity_id = e.id
           )
        ORDER BY e.canonical_name
      `)
    ).rows as StaleRow[];
  }

  const total = staleEntities.length;
  logger.info(`Entity summaries: found ${total} entities to ${forceAll ? "regenerate" : "update"}`);

  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = staleEntities.slice(i, i + BATCH_SIZE);

    for (const entity of batch) {
      try {
        const summary = await generateEntitySummary(entity.id);
        if (summary) {
          const wordCount = summary.split(/\s+/).length;
          logger.info(
            `[entity ${updated + skipped + 1}/${total}] Generated summary for "${entity.canonical_name}" (${entity.type}) — ${wordCount} words`,
          );
          updated++;
        } else {
          skipped++;
        }
      } catch (error) {
        logger.error(
          `[entity ${updated + skipped + 1}/${total}] Failed to generate summary for "${entity.canonical_name}"`,
          { error: String(error) },
        );
        skipped++;
      }

      if (i + batch.indexOf(entity) < total - 1) {
        await sleep(DELAY_BETWEEN_CALLS_MS);
      }
    }
  }

  logger.info(`Entity summaries complete: ${updated} updated, ${skipped} skipped`);
  return { updated, skipped };
}

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories } from "@aura/db/schema";
import { logger } from "../lib/logger.js";

/**
 * Memory consolidation — runs as a daily Vercel Cron job.
 *
 * Responsibilities:
 * 1. Decay relevance scores of older memories
 * 2. Find and merge duplicate memories (high cosine similarity)
 * 3. Flag contradictory memories
 */

/**
 * Decay relevance scores.
 * Multiplies all relevance_scores by a decay factor (0.995 per day).
 * This means a memory loses ~50% relevance after ~138 days.
 * Memories with a score below the floor are not deleted, just deprioritized.
 */
export async function decayRelevanceScores(): Promise<number> {
  const DECAY_FACTOR = 0.995;
  const MIN_SCORE = 0.01;

  try {
    const result = await db
      .update(memories)
      .set({
        relevanceScore: sql`GREATEST(${MIN_SCORE}, ${memories.relevanceScore} * ${DECAY_FACTOR})`,
        updatedAt: new Date(),
      })
      .where(sql`${memories.relevanceScore} > ${MIN_SCORE} AND ${memories.status} = 'current'`);

    logger.info("Decayed relevance scores", { factor: DECAY_FACTOR });
    return 0; // drizzle doesn't return rowcount on update easily
  } catch (error) {
    logger.error("Failed to decay relevance scores", { error: String(error) });
    throw error;
  }
}

/**
 * Find and merge duplicate memories.
 * Memories with cosine similarity > 0.95 are considered duplicates.
 * Keeps the more recent one (or the one with higher relevance).
 * Only considers current memories — skips already-superseded ones.
 */
export async function mergeDuplicateMemories(): Promise<number> {
  try {
    const allMemories = await db.execute(sql`
      SELECT id, relevance_score, created_at
      FROM memories
      WHERE embedding IS NOT NULL
        AND relevance_score > 0.01
        AND status = 'current'
      ORDER BY id
    `);

    if (!allMemories.rows || allMemories.rows.length === 0) {
      logger.info("No current memories with embeddings found");
      return 0;
    }

    let mergedCount = 0;
    const supersededIds = new Set<string>();
    const keeperHasForwardLink = new Set<string>();

    for (const mem of allMemories.rows as any[]) {
      if (supersededIds.has(mem.id)) continue;

      const neighbors = await db.execute(sql`
        SELECT
          id,
          relevance_score,
          created_at,
          1 - (embedding <=> (SELECT embedding FROM memories WHERE id = ${mem.id})) AS similarity
        FROM memories
        WHERE id <> ${mem.id}
          AND embedding IS NOT NULL
          AND relevance_score > 0.01
          AND status = 'current'
          AND 1 - (embedding <=> (SELECT embedding FROM memories WHERE id = ${mem.id})) > 0.95
        ORDER BY embedding <=> (SELECT embedding FROM memories WHERE id = ${mem.id})
        LIMIT 10
      `);

      if (!neighbors.rows || neighbors.rows.length === 0) continue;

      for (const neighbor of neighbors.rows as any[]) {
        if (supersededIds.has(neighbor.id)) continue;

        const score1 = Number(mem.relevance_score);
        const score2 = Number(neighbor.relevance_score);

        let keepId: string;
        let loserId: string;
        if (score1 > score2) {
          keepId = mem.id;
          loserId = neighbor.id;
        } else if (score2 > score1) {
          keepId = neighbor.id;
          loserId = mem.id;
        } else {
          const created1 = new Date(mem.created_at).getTime();
          const created2 = new Date(neighbor.created_at).getTime();
          if (created1 >= created2) {
            keepId = mem.id;
            loserId = neighbor.id;
          } else {
            keepId = neighbor.id;
            loserId = mem.id;
          }
        }

        if (supersededIds.has(loserId) || supersededIds.has(keepId)) {
          continue;
        }

        const boostedScore = Math.min(
          1.0,
          Math.max(score1, score2) * 1.1,
        );
        const now = new Date();

        const isFirstLoser = !keeperHasForwardLink.has(keepId);

        await db.transaction(async (tx) => {
          await tx
            .update(memories)
            .set({
              relevanceScore: boostedScore,
              ...(isFirstLoser ? { supersedesMemoryId: loserId } : {}),
              updatedAt: now,
            })
            .where(sql`${memories.id} = ${keepId}`);

          await tx
            .update(memories)
            .set({
              status: "superseded",
              supersededAt: now,
              supersededByMemoryId: keepId,
              validUntil: now,
              updatedAt: now,
            })
            .where(sql`${memories.id} = ${loserId}`);
        });

        keeperHasForwardLink.add(keepId);
        supersededIds.add(loserId);
        mergedCount++;
      }
    }

    logger.info(`Merged ${mergedCount} duplicate memories`);
    return mergedCount;
  } catch (error) {
    logger.error("Failed to merge duplicate memories", {
      error: String(error),
    });
    throw error;
  }
}

/**
 * Run full consolidation pipeline.
 */
export async function runConsolidation(): Promise<{
  decayed: boolean;
  mergedCount: number;
}> {
  logger.info("Starting memory consolidation");
  const start = Date.now();

  await decayRelevanceScores();
  const mergedCount = await mergeDuplicateMemories();

  logger.info(`Consolidation completed in ${Date.now() - start}ms`, {
    mergedCount,
  });

  return { decayed: true, mergedCount };
}

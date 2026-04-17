import { generateObject } from "ai";
import { z } from "zod";
import { sql, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { entities, memories, memoryEntities, users } from "@aura/db/schema";
import { getFastModel } from "../lib/ai.js";
import { logger } from "../lib/logger.js";

const MAX_MEMORIES_PER_ENTITY = 50;
const MIN_RELEVANCE_SCORE = 0.1;
const SUMMARY_CONCURRENCY = 1;

function getSystemPrompt(entityName: string, entityType: string): string {
  const base = `You are summarizing what Aura (an AI team member) knows about "${entityName}" (${entityType}).`;

  const rules = `
Rules:
- ONLY state facts present in the profile data and memories below. Do not infer, speculate, or add analysis beyond what is provided. If there's only one memory with a passing mention, the summary should reflect that — a single sentence is fine.
- 2-3 sentences MAX. Be brutally concise.
- Present tense for current state. Past tense only for important context.
- No filler phrases ("This entity is...", "Based on memories...").
- Start directly with the most important fact.
- Include specifics: names, numbers, dates when available.
- If information conflicts, state the most recent version.`;

  const typeGuidance: Record<string, string> = {
    person: `${base}
Focus on: role/title, what they work on, key relationships, communication style, notable preferences or decisions.
Skip: routine interactions, trivial scheduling details.
Use pronouns matching gender field exactly. If gender is male -> he/him/his. If female -> she/her/hers. If non_binary or null -> they/them/their. Never use pronouns conflicting with the gender field.
${rules}`,

    company: `${base}
Focus on: what the company does, relationship to RealAdvisor, key products/services, any active deals or partnerships.
Skip: generic industry descriptions.
${rules}`,

    channel: `${base}
Focus on: what this channel is used for, key metrics or business context discussed there, active themes.
Skip: individual message-level details.
${rules}`,

    technology: `${base}
Focus on: what it is, how it's used in the stack, any recent migrations or decisions about it.
Skip: generic descriptions of the technology.
${rules}`,

    product: `${base}
Focus on: what it does, who uses it, current status, key recent changes or decisions.
Skip: feature-level minutiae.
${rules}`,

    project: `${base}
If the project/issue is closed/completed/merged: respond with ONE sentence stating what it was and that it's done. Nothing more.
If active: focus on current status, blockers, owners, key decisions.
${rules}`,
  };

  return typeGuidance[entityType] || `${base}\nSummarize what's known. ${rules}`;
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

  type MemoryRow = { content: string; type: string; relevanceScore: number };

  const linkedMemories: MemoryRow[] = await db
    .select({
      content: memories.content,
      type: memories.type,
      relevanceScore: memories.relevanceScore,
    })
    .from(memoryEntities)
    .innerJoin(memories, eq(memoryEntities.memoryId, memories.id))
    .where(
      sql`${memoryEntities.entityId} = ${entityId}
        AND ${memories.relevanceScore} > ${MIN_RELEVANCE_SCORE}
        AND ${memories.status} IN ('current', 'disputed')`,
    )
    .orderBy(sql`${memories.relevanceScore} DESC`)
    .limit(MAX_MEMORIES_PER_ENTITY);

  if (linkedMemories.length === 0) {
    return "";
  }

  const memoriesText = linkedMemories
    .map((m) => `- [${m.type}] ${m.content}`)
    .join("\n");

  // For person entities, include linked user profile data as context
  let profileContext = "";
  if (entity.type === "person") {
    const linkedUsers = await db
      .select({
        displayName: users.displayName,
        gender: users.gender,
        preferredLanguage: users.preferredLanguage,
        role: users.role,
        jobTitle: users.jobTitle,
        timezone: users.timezone,
        slackUserId: users.slackUserId,
      })
      .from(users)
      .where(eq(users.entityId, entityId))
      .limit(1);

    if (linkedUsers.length > 0) {
      const u = linkedUsers[0];
      const parts: string[] = [];
      parts.push(`Display name: ${u.displayName}`);
      parts.push(`Gender: ${u.gender ?? "null"}`);
      parts.push(`Preferred language: ${u.preferredLanguage ?? "null"}`);
      parts.push(`Role: ${u.role}`);
      if (u.jobTitle) parts.push(`Title: ${u.jobTitle}`);
      if (u.timezone) parts.push(`Timezone: ${u.timezone}`);
      if (parts.length > 0) {
        profileContext = `\n\nProfile data:\n${parts.map((p) => `- ${p}`).join("\n")}`;
      }
    }
  }

  const model = await getFastModel();

  const { object } = await generateObject({
    model,
    schema: z.object({ summary: z.string() }),
    system: getSystemPrompt(entity.canonicalName, entity.type ?? "unknown"),
    prompt: `${profileContext ? `${profileContext}\n\n` : ""}Memories:\n${memoriesText}`,
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
 * Ordering: person > company > channel > technology > product > project,
 * then by memory count DESC within each type (most-referenced entities first).
 */
export async function regenerateStaleSummaries(
  opts?: {
    forceAll?: boolean;
    concurrency?: number;
    onProgress?: (completed: number, total: number) => void;
  },
): Promise<{ updated: number; skipped: number; totalCandidates: number }> {
  const forceAll = opts?.forceAll ?? false;

  type StaleRow = {
    id: string;
    canonical_name: string;
    type: string;
    memory_count: number;
  };

  const whereClause = forceAll
    ? sql`TRUE`
    : sql`(e.summary_updated_at IS NULL
        OR e.summary_updated_at < (
          SELECT MAX(m.created_at)
          FROM memories m
          JOIN memory_entities me2 ON me2.memory_id = m.id
          WHERE me2.entity_id = e.id
        ))`;

  const staleEntities = (
    await db.execute(sql`
      SELECT e.id, e.canonical_name, e.type, COUNT(me.memory_id)::int as memory_count
      FROM entities e
      JOIN memory_entities me ON me.entity_id = e.id
      WHERE ${whereClause}
      GROUP BY e.id, e.canonical_name, e.type
      ORDER BY
        CASE e.type
          WHEN 'person' THEN 0
          WHEN 'company' THEN 1
          WHEN 'channel' THEN 2
          WHEN 'technology' THEN 3
          WHEN 'product' THEN 4
          WHEN 'project' THEN 5
          ELSE 99
        END,
        COUNT(me.memory_id) DESC
    `)
  ).rows as StaleRow[];

  const total = staleEntities.length;
  logger.info(
    `Entity summaries: found ${total} entities to ${forceAll ? "regenerate" : "update"}`,
  );

  let updated = 0;
  let skipped = 0;
  let idx = 0;

  async function worker() {
    while (idx < total) {
      const i = idx++;
      const entity = staleEntities[i];
      try {
        const summary = await generateEntitySummary(entity.id);
        if (summary) {
          const wordCount = summary.split(/\s+/).length;
          logger.info(
            `[entity ${i + 1}/${total}] Generated summary for "${entity.canonical_name}" (${entity.type}, ${entity.memory_count} memories) — ${wordCount} words`,
          );
          updated++;
        } else {
          skipped++;
        }
      } catch (error) {
        logger.error(
          `[entity ${i + 1}/${total}] Failed to generate summary for "${entity.canonical_name}"`,
          { error: String(error) },
        );
        skipped++;
      }
      opts?.onProgress?.(updated + skipped, total);
    }
  }

  const concurrency = opts?.concurrency ?? SUMMARY_CONCURRENCY;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker()),
  );

  logger.info(
    `Entity summaries complete: ${updated} updated, ${skipped} skipped`,
  );
  return { updated, skipped, totalCandidates: total };
}

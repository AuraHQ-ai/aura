import { sql } from "drizzle-orm";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { db } from "../db/client.js";
import { entities, entityAliases, memoryEntities } from "@aura/db/schema";
import type { EntityType, MemoryEntityRole } from "@aura/db/schema";
import { logger } from "../lib/logger.js";

export interface ResolvedEntity {
  entityId: string;
  canonicalName: string;
  type: EntityType;
  confidence: "exact" | "alias" | "fuzzy" | "new";
}

// ── Fuzzy Disambiguation (Pass 2 LLM) ──────────────────────────────────────

interface FuzzyCandidate {
  entityId: string;
  canonicalName: string;
  type: string;
  similarity: number;
}

const disambiguationSchema = z.object({
  match_index: z
    .number()
    .nullable()
    .describe(
      "0-based index of the candidate that is the SAME entity as the query, or null if none match",
    ),
});

/**
 * Ask the LLM whether a new entity name matches any of the fuzzy candidates.
 * Returns the matched candidate or null if the LLM says it's a new entity.
 */
export async function disambiguateFuzzyMatches(
  name: string,
  type: string,
  candidates: FuzzyCandidate[],
  model: LanguageModel,
): Promise<FuzzyCandidate | null> {
  if (candidates.length === 0) return null;

  const candidateList = candidates
    .map((c, i) => `  ${i}: "${c.canonicalName}" (${c.type}, similarity ${c.similarity.toFixed(2)})`)
    .join("\n");

  const { output } = await generateText({
    model,
    output: Output.object({ schema: disambiguationSchema }),
    system: `You are disambiguating entity names. Given a new entity name and a list of existing entities with similar names, determine if the new name refers to the SAME real-world entity as any candidate.

Return match_index (0-based) of the matching candidate, or null if none match.

CRITICAL rules:
- "PR #43" and "PR #143" are DIFFERENT pull requests — do NOT match them.
- "Issue #23" and "Issue #233" are DIFFERENT issues — do NOT match them.
- Numbered identifiers (PRs, issues, tickets) with different numbers are ALWAYS different entities.
- Only match when the names genuinely refer to the same thing (e.g. "PostgreSQL" ↔ "Postgres", "Joan Rodriguez" ↔ "Joan", "RealAdvisor" ↔ "RA").`,
    prompt: `New entity: "${name}" (${type})\n\nCandidates:\n${candidateList}`,
  });

  if (output?.match_index != null && output.match_index >= 0 && output.match_index < candidates.length) {
    return candidates[output.match_index];
  }
  return null;
}

// ── Alias Persistence ───────────────────────────────────────────────────────

async function persistLlmAliases(entityId: string, llmAliases?: string[]): Promise<void> {
  if (!llmAliases || llmAliases.length === 0) return;
  for (const raw of llmAliases) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      await db
        .insert(entityAliases)
        .values({
          entityId,
          alias: trimmed,
          source: "llm_extracted",
        })
        .onConflictDoNothing();
    } catch {
      // ignore duplicate alias conflicts
    }
  }
}

// ── Row extraction helper ───────────────────────────────────────────────────

function extractRows(result: unknown): Array<Record<string, any>> {
  return ((result as any).rows ?? result) as Array<Record<string, any>>;
}

/**
 * Resolve a name to an entity using the cascade:
 * 1. Exact canonical match
 * 2. Exact alias match
 * 3. Trigram fuzzy match (>0.4) with LLM disambiguation (if model provided)
 * 4. Create new entity
 *
 * Pass `disambiguateModel` to enable two-pass LLM disambiguation on fuzzy matches.
 * Without it, fuzzy matches are accepted blindly (backward-compat for read-only paths).
 */
export async function resolveEntity(
  name: string,
  type: EntityType,
  workspaceId: string,
  opts?: { llmAliases?: string[]; disambiguateModel?: LanguageModel },
): Promise<ResolvedEntity> {
  const llmAliases = opts?.llmAliases;
  const disambiguateModel = opts?.disambiguateModel;
  const lowerName = name.toLowerCase().trim();
  if (!lowerName) {
    throw new Error("Entity name cannot be empty");
  }

  try {
    // 1. Exact canonical match
    const exactRows = extractRows(
      await db.execute(sql`
        SELECT id, canonical_name, type
        FROM entities
        WHERE workspace_id = ${workspaceId}
          AND type = ${type}
          AND lower(canonical_name) = ${lowerName}
        LIMIT 1
      `),
    );
    if (exactRows.length > 0) {
      await persistLlmAliases(exactRows[0].id, llmAliases);
      return {
        entityId: exactRows[0].id,
        canonicalName: exactRows[0].canonical_name,
        type: exactRows[0].type as EntityType,
        confidence: "exact",
      };
    }

    // 2. Exact alias match (same type)
    const aliasRows = extractRows(
      await db.execute(sql`
        SELECT e.id, e.canonical_name, e.type
        FROM entities e
        JOIN entity_aliases ea ON e.id = ea.entity_id
        WHERE ea.alias_lower = ${lowerName}
          AND e.type = ${type}
          AND e.workspace_id = ${workspaceId}
        LIMIT 1
      `),
    );
    if (aliasRows.length > 0) {
      await persistLlmAliases(aliasRows[0].id, llmAliases);
      return {
        entityId: aliasRows[0].id,
        canonicalName: aliasRows[0].canonical_name,
        type: aliasRows[0].type as EntityType,
        confidence: "alias",
      };
    }

    // 2.5 Cross-type exact match
    const crossTypeRows = extractRows(
      await db.execute(sql`
        SELECT id, canonical_name, type
        FROM entities
        WHERE workspace_id = ${workspaceId}
          AND lower(canonical_name) = ${lowerName}
        LIMIT 1
      `),
    );
    if (crossTypeRows.length > 0) {
      await persistLlmAliases(crossTypeRows[0].id, llmAliases);
      return {
        entityId: crossTypeRows[0].id,
        canonicalName: crossTypeRows[0].canonical_name,
        type: crossTypeRows[0].type as EntityType,
        confidence: "exact",
      };
    }

    // 2.6 Cross-type alias match
    const crossAliasRows = extractRows(
      await db.execute(sql`
        SELECT e.id, e.canonical_name, e.type
        FROM entities e
        JOIN entity_aliases ea ON e.id = ea.entity_id
        WHERE ea.alias_lower = ${lowerName}
          AND e.workspace_id = ${workspaceId}
        LIMIT 1
      `),
    );
    if (crossAliasRows.length > 0) {
      await persistLlmAliases(crossAliasRows[0].id, llmAliases);
      return {
        entityId: crossAliasRows[0].id,
        canonicalName: crossAliasRows[0].canonical_name,
        type: crossAliasRows[0].type as EntityType,
        confidence: "alias",
      };
    }

    // 3. Trigram fuzzy match — get top 5 candidates
    const fuzzyRows = extractRows(
      await db.execute(sql`
        SELECT * FROM (
          SELECT DISTINCT ON (e.id)
            e.id, e.canonical_name, e.type,
            similarity(ea.alias_lower, ${lowerName}) AS sim
          FROM entities e
          JOIN entity_aliases ea ON e.id = ea.entity_id
          WHERE ea.alias_lower % ${lowerName}
            AND e.workspace_id = ${workspaceId}
            AND similarity(ea.alias_lower, ${lowerName}) > 0.4
          ORDER BY e.id, sim DESC
        ) sub
        ORDER BY sim DESC
        LIMIT 50
      `),
    );

    if (fuzzyRows.length > 0) {
      // Sort by similarity descending, take top 5
      const candidates: FuzzyCandidate[] = fuzzyRows
        .sort((a, b) => Number(b.sim) - Number(a.sim))
        .slice(0, 5)
        .map((r) => ({
          entityId: r.id,
          canonicalName: r.canonical_name,
          type: r.type,
          similarity: Number(r.sim),
        }));

      if (disambiguateModel) {
        const match = await disambiguateFuzzyMatches(name, type, candidates, disambiguateModel);
        if (match) {
          await persistLlmAliases(match.entityId, llmAliases);
          // Register the new name as an alias of the matched entity
          await persistLlmAliases(match.entityId, [name]);
          return {
            entityId: match.entityId,
            canonicalName: match.canonicalName,
            type: match.type as EntityType,
            confidence: "fuzzy",
          };
        }
        // LLM said no match — fall through to create new entity
      } else {
        // No disambiguation model — accept best fuzzy match (backward compat)
        const best = candidates[0];
        await persistLlmAliases(best.entityId, llmAliases);
        return {
          entityId: best.entityId,
          canonicalName: best.canonicalName,
          type: best.type as EntityType,
          confidence: "fuzzy",
        };
      }
    }

    // 4. Create new entity + aliases
    const [newEntity] = await db
      .insert(entities)
      .values({
        workspaceId,
        type,
        canonicalName: name,
      })
      .onConflictDoNothing()
      .returning();

    if (newEntity) {
      await db
        .insert(entityAliases)
        .values({
          entityId: newEntity.id,
          alias: name,
          source: "extracted",
        })
        .onConflictDoNothing();

      await persistLlmAliases(newEntity.id, llmAliases);

      if (type === "person") {
        const parts = name.split(/\s+/).filter((p) => p.length > 1);
        const additionalAliases = new Set<string>();
        additionalAliases.add(name.toLowerCase());
        for (const part of parts) {
          additionalAliases.add(part.toLowerCase());
        }
        const primaryLower = name.toLowerCase();
        for (const alias of additionalAliases) {
          if (alias === primaryLower && parts.length <= 1) continue;
          try {
            await db
              .insert(entityAliases)
              .values({
                entityId: newEntity.id,
                alias,
                source: "auto_generated",
              })
              .onConflictDoNothing();
          } catch {
            // ignore duplicate alias conflicts
          }
        }
      }

      return {
        entityId: newEntity.id,
        canonicalName: newEntity.canonicalName,
        type: newEntity.type as EntityType,
        confidence: "new",
      };
    }

    // Conflict on insert — retry exact match
    const retryRows = extractRows(
      await db.execute(sql`
        SELECT id, canonical_name, type
        FROM entities
        WHERE workspace_id = ${workspaceId}
          AND type = ${type}
          AND lower(canonical_name) = ${lowerName}
        LIMIT 1
      `),
    );
    if (retryRows.length > 0) {
      await persistLlmAliases(retryRows[0].id, llmAliases);
      return {
        entityId: retryRows[0].id,
        canonicalName: retryRows[0].canonical_name,
        type: retryRows[0].type as EntityType,
        confidence: "exact",
      };
    }

    throw new Error(`Failed to create or find entity: ${name} (${type})`);
  } catch (error) {
    logger.error("Entity resolution failed", {
      name,
      type,
      workspaceId,
      error: String(error),
    });
    throw error;
  }
}

/**
 * Read-only entity resolution: resolves a name to an existing entity without
 * creating new ones. Used during retrieval to avoid polluting the entity store.
 *
 * Cascade:
 * 1. Exact canonical match (same type)
 * 2. Exact alias match (same type)
 * 3. Exact canonical match (any type)
 * 4. Exact alias match (any type)
 * 5. Trigram fuzzy match (any type, similarity > 0.4)
 */
export async function resolveEntityReadOnly(
  name: string,
  type: EntityType,
  workspaceId: string,
): Promise<ResolvedEntity | null> {
  const lowerName = name.toLowerCase().trim();
  if (!lowerName) return null;

  try {
    // 1. Exact canonical match (same type)
    const exactCanonical = await db.execute(sql`
      SELECT id, canonical_name, type
      FROM entities
      WHERE workspace_id = ${workspaceId}
        AND type = ${type}
        AND lower(canonical_name) = ${lowerName}
      LIMIT 1
    `);
    const exactRows = ((exactCanonical as any).rows ?? exactCanonical) as Array<Record<string, any>>;
    if (exactRows.length > 0) {
      return {
        entityId: exactRows[0].id,
        canonicalName: exactRows[0].canonical_name,
        type: exactRows[0].type as EntityType,
        confidence: "exact",
      };
    }

    // 2. Exact alias match (same type)
    const exactAlias = await db.execute(sql`
      SELECT e.id, e.canonical_name, e.type
      FROM entities e
      JOIN entity_aliases ea ON e.id = ea.entity_id
      WHERE ea.alias_lower = ${lowerName}
        AND e.type = ${type}
        AND e.workspace_id = ${workspaceId}
      LIMIT 1
    `);
    const aliasRows = ((exactAlias as any).rows ?? exactAlias) as Array<Record<string, any>>;
    if (aliasRows.length > 0) {
      return {
        entityId: aliasRows[0].id,
        canonicalName: aliasRows[0].canonical_name,
        type: aliasRows[0].type as EntityType,
        confidence: "alias",
      };
    }

    // 3. Exact canonical match (any type)
    const crossTypeCanonical = await db.execute(sql`
      SELECT id, canonical_name, type
      FROM entities
      WHERE workspace_id = ${workspaceId}
        AND lower(canonical_name) = ${lowerName}
      LIMIT 1
    `);
    const crossCanonicalRows = ((crossTypeCanonical as any).rows ?? crossTypeCanonical) as Array<Record<string, any>>;
    if (crossCanonicalRows.length > 0) {
      return {
        entityId: crossCanonicalRows[0].id,
        canonicalName: crossCanonicalRows[0].canonical_name,
        type: crossCanonicalRows[0].type as EntityType,
        confidence: "exact",
      };
    }

    // 4. Exact alias match (any type)
    const crossTypeAlias = await db.execute(sql`
      SELECT e.id, e.canonical_name, e.type
      FROM entities e
      JOIN entity_aliases ea ON e.id = ea.entity_id
      WHERE ea.alias_lower = ${lowerName}
        AND e.workspace_id = ${workspaceId}
      LIMIT 1
    `);
    const crossAliasRows = ((crossTypeAlias as any).rows ?? crossTypeAlias) as Array<Record<string, any>>;
    if (crossAliasRows.length > 0) {
      return {
        entityId: crossAliasRows[0].id,
        canonicalName: crossAliasRows[0].canonical_name,
        type: crossAliasRows[0].type as EntityType,
        confidence: "alias",
      };
    }

    // 5. Trigram fuzzy match (any type, similarity > 0.4)
    const fuzzyMatch = await db.execute(sql`
      SELECT e.id, e.canonical_name, e.type, similarity(ea.alias_lower, ${lowerName}) AS sim
      FROM entities e
      JOIN entity_aliases ea ON e.id = ea.entity_id
      WHERE ea.alias_lower % ${lowerName}
        AND e.workspace_id = ${workspaceId}
        AND similarity(ea.alias_lower, ${lowerName}) > 0.4
      ORDER BY sim DESC
      LIMIT 1
    `);
    const fuzzyRows = ((fuzzyMatch as any).rows ?? fuzzyMatch) as Array<Record<string, any>>;
    if (fuzzyRows.length > 0) {
      return {
        entityId: fuzzyRows[0].id,
        canonicalName: fuzzyRows[0].canonical_name,
        type: fuzzyRows[0].type as EntityType,
        confidence: "fuzzy",
      };
    }

    return null;
  } catch (error) {
    logger.warn("Read-only entity resolution failed", {
      name,
      type,
      workspaceId,
      error: String(error),
    });
    return null;
  }
}

const ROLE_PRIORITY: Record<string, number> = { subject: 0, object: 1, mentioned: 2 };

/**
 * Resolve multiple entities from extraction output.
 * Deduplicates by extracted name, keeping the highest-priority role per name.
 */
export async function resolveEntities(
  extracted: Array<{ name: string; type: EntityType; role?: MemoryEntityRole; aliases?: string[] }>,
  workspaceId: string,
  disambiguateModel?: LanguageModel,
): Promise<Array<ResolvedEntity & { role?: MemoryEntityRole }>> {
  if (extracted.length === 0) return [];

  // Deduplicate by type:name, keeping the highest-priority role and merging aliases
  const bestByKey = new Map<string, { name: string; type: EntityType; role?: MemoryEntityRole; aliases?: string[] }>();
  for (const item of extracted) {
    const key = `${item.type}:${item.name.toLowerCase()}`;
    const existing = bestByKey.get(key);
    if (!existing) {
      bestByKey.set(key, { ...item });
    } else {
      const mergedAliases = [
        ...(existing.aliases ?? []),
        ...(item.aliases ?? []),
      ];
      if ((ROLE_PRIORITY[item.role ?? "mentioned"] ?? 2) < (ROLE_PRIORITY[existing.role ?? "mentioned"] ?? 2)) {
        bestByKey.set(key, { ...item, aliases: mergedAliases });
      } else {
        existing.aliases = mergedAliases;
      }
    }
  }

  const results: Array<ResolvedEntity & { role?: MemoryEntityRole }> = [];
  for (const item of bestByKey.values()) {
    try {
      const resolved = await resolveEntity(item.name, item.type, workspaceId, {
        llmAliases: item.aliases,
        disambiguateModel,
      });
      results.push({ ...resolved, role: item.role });
    } catch (error) {
      logger.warn("Skipping unresolvable entity", {
        name: item.name,
        type: item.type,
        error: String(error),
      });
    }
  }

  return results;
}

/**
 * Link a memory to its resolved entities via the memory_entities junction table.
 * Accepts resolved entities with optional per-entity role; defaults to "mentioned".
 */
export async function linkMemoryEntities(
  memoryId: string,
  resolvedEntities: Array<ResolvedEntity & { role?: MemoryEntityRole }>,
): Promise<void> {
  if (resolvedEntities.length === 0) return;

  // Deduplicate by entityId, keeping the most important role
  const best = new Map<string, { entityId: string; role: MemoryEntityRole }>();
  for (const e of resolvedEntities) {
    const role = e.role ?? ("mentioned" as MemoryEntityRole);
    const existing = best.get(e.entityId);
    if (!existing || (ROLE_PRIORITY[role] ?? 2) < (ROLE_PRIORITY[existing.role] ?? 2)) {
      best.set(e.entityId, { entityId: e.entityId, role });
    }
  }

  const values = [...best.values()].map((v) => ({
    memoryId,
    entityId: v.entityId,
    role: v.role,
  }));

  try {
    await db
      .insert(memoryEntities)
      .values(values)
      .onConflictDoNothing();
  } catch (error) {
    logger.error("Failed to link memory entities", {
      memoryId,
      entityCount: values.length,
      error: String(error),
    });
  }
}

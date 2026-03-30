import { sql } from "drizzle-orm";
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

/**
 * Resolve a name to an entity using the cascade:
 * 1. Exact canonical match
 * 2. Exact alias match
 * 3. Trigram fuzzy match (>0.4 similarity)
 * 4. Create new entity
 */
export async function resolveEntity(
  name: string,
  type: EntityType,
  workspaceId: string,
  llmAliases?: string[],
): Promise<ResolvedEntity> {
  const lowerName = name.toLowerCase().trim();
  if (!lowerName) {
    throw new Error("Entity name cannot be empty");
  }

  try {
    // 1. Exact canonical match
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

    // 2.5 Cross-type exact match (prevents "SMG" as technology creating a new entity when "SMG" as company exists)
    const crossTypeMatch = await db.execute(sql`
      SELECT id, canonical_name, type
      FROM entities
      WHERE workspace_id = ${workspaceId}
        AND lower(canonical_name) = ${lowerName}
      LIMIT 1
    `);
    const crossTypeRows = ((crossTypeMatch as any).rows ?? crossTypeMatch) as Array<Record<string, any>>;
    if (crossTypeRows.length > 0) {
      return {
        entityId: crossTypeRows[0].id,
        canonicalName: crossTypeRows[0].canonical_name,
        type: crossTypeRows[0].type as EntityType,
        confidence: "exact",
      };
    }

    // 2.6 Cross-type alias match
    const crossTypeAlias = await db.execute(sql`
      SELECT e.id, e.canonical_name, e.type
      FROM entities e
      JOIN entity_aliases ea ON e.id = ea.entity_id
      WHERE ea.alias_lower = ${lowerName}
        AND e.workspace_id = ${workspaceId}
      LIMIT 1
    `);
    const crossTypeAliasRows = ((crossTypeAlias as any).rows ?? crossTypeAlias) as Array<Record<string, any>>;
    if (crossTypeAliasRows.length > 0) {
      return {
        entityId: crossTypeAliasRows[0].id,
        canonicalName: crossTypeAliasRows[0].canonical_name,
        type: crossTypeAliasRows[0].type as EntityType,
        confidence: "alias",
      };
    }

    // 3. Trigram fuzzy match across all types (>0.4 similarity)
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
      // Create primary alias
      await db
        .insert(entityAliases)
        .values({
          entityId: newEntity.id,
          alias: name,
          source: "extracted",
        })
        .onConflictDoNothing();

      // Insert LLM-provided aliases
      if (llmAliases && llmAliases.length > 0) {
        for (const raw of llmAliases) {
          const trimmed = raw.trim();
          if (!trimmed) continue;
          try {
            await db
              .insert(entityAliases)
              .values({
                entityId: newEntity.id,
                alias: trimmed,
                source: "llm_extracted",
              })
              .onConflictDoNothing();
          } catch {
            // ignore duplicate alias conflicts
          }
        }
      }

      // Auto-generate additional aliases for person entities
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

    // Conflict on insert means another concurrent request created it — retry exact match
    const retryResult = await db.execute(sql`
      SELECT id, canonical_name, type
      FROM entities
      WHERE workspace_id = ${workspaceId}
        AND type = ${type}
        AND lower(canonical_name) = ${lowerName}
      LIMIT 1
    `);
    const retryRows = ((retryResult as any).rows ?? retryResult) as Array<Record<string, any>>;
    if (retryRows.length > 0) {
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
): Promise<Array<ResolvedEntity & { role?: MemoryEntityRole }>> {
  if (extracted.length === 0) return [];

  // Deduplicate by type:name, keeping the highest-priority role and merging aliases
  const bestByKey = new Map<string, { name: string; type: EntityType; role?: MemoryEntityRole; aliases?: string[] }>();
  for (const item of extracted) {
    const key = `${item.type}:${item.name.toLowerCase()}`;
    const existing = bestByKey.get(key);
    if (!existing || (ROLE_PRIORITY[item.role ?? "mentioned"] ?? 2) < (ROLE_PRIORITY[existing.role ?? "mentioned"] ?? 2)) {
      const mergedAliases = [
        ...(existing?.aliases ?? []),
        ...(item.aliases ?? []),
      ];
      bestByKey.set(key, { ...item, aliases: mergedAliases });
    }
  }

  const results: Array<ResolvedEntity & { role?: MemoryEntityRole }> = [];
  for (const item of bestByKey.values()) {
    try {
      const resolved = await resolveEntity(item.name, item.type, workspaceId, item.aliases);
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

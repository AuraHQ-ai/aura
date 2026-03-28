import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { entities, entityAliases, memoryEntities } from "@aura/db/schema";
import { logger } from "../lib/logger.js";

export interface ResolvedEntity {
  entityId: string;
  canonicalName: string;
  type: string;
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
  type: string,
  workspaceId: string,
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
        type: exactRows[0].type,
        confidence: "exact",
      };
    }

    // 2. Exact alias match
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
        type: aliasRows[0].type,
        confidence: "alias",
      };
    }

    // 3. Trigram fuzzy match (>0.4 similarity)
    const fuzzyMatch = await db.execute(sql`
      SELECT e.id, e.canonical_name, e.type, similarity(ea.alias_lower, ${lowerName}) AS sim
      FROM entities e
      JOIN entity_aliases ea ON e.id = ea.entity_id
      WHERE ea.alias_lower % ${lowerName}
        AND e.type = ${type}
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
        type: fuzzyRows[0].type,
        confidence: "fuzzy",
      };
    }

    // 4. Create new entity + alias
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

      return {
        entityId: newEntity.id,
        canonicalName: newEntity.canonicalName,
        type: newEntity.type,
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
        type: retryRows[0].type,
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
  type: string,
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
        type: exactRows[0].type,
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
        type: aliasRows[0].type,
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
        type: crossCanonicalRows[0].type,
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
        type: crossAliasRows[0].type,
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
        type: fuzzyRows[0].type,
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

/**
 * Resolve multiple entities from extraction output.
 */
export async function resolveEntities(
  extracted: Array<{ name: string; type: string }>,
  workspaceId: string,
): Promise<ResolvedEntity[]> {
  if (extracted.length === 0) return [];

  const results: ResolvedEntity[] = [];
  const seen = new Set<string>();

  for (const item of extracted) {
    const key = `${item.type}:${item.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const resolved = await resolveEntity(item.name, item.type, workspaceId);
      results.push(resolved);
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
 */
export async function linkMemoryEntities(
  memoryId: string,
  resolvedEntities: ResolvedEntity[],
): Promise<void> {
  if (resolvedEntities.length === 0) return;

  const values = resolvedEntities.map((e) => ({
    memoryId,
    entityId: e.entityId,
    role: "mentioned" as const,
  }));

  try {
    await db
      .insert(memoryEntities)
      .values(values)
      .onConflictDoNothing();
  } catch (error) {
    logger.error("Failed to link memory entities", {
      memoryId,
      entityCount: resolvedEntities.length,
      error: String(error),
    });
  }
}

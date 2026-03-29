import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { entities, entityAliases, memoryEntities, users } from "@aura/db/schema";
import type { EntityType } from "@aura/db/schema";
import { logger } from "../lib/logger.js";

// ── Alias Enrichment ────────────────────────────────────────────────────────

function generatePersonAliases(canonicalName: string): string[] {
  const aliases = new Set<string>();
  const parts = canonicalName.trim().split(/\s+/);

  aliases.add(canonicalName.toLowerCase());

  if (parts.length >= 2) {
    aliases.add(parts[0].toLowerCase());
    aliases.add(parts[parts.length - 1].toLowerCase());
  }

  return [...aliases];
}

function generateOrgAliases(canonicalName: string): string[] {
  const aliases = new Set<string>();

  aliases.add(canonicalName.toLowerCase());

  // Whitespace-stripped variant ("Real Advisor" → "realadvisor")
  const stripped = canonicalName.replace(/\s+/g, "").toLowerCase();
  if (stripped !== canonicalName.toLowerCase()) {
    aliases.add(stripped);
  }

  // Acronym from capital letters ("RealAdvisor" → "RA", "ImmoScout24" → "IS")
  const capitals = canonicalName.match(/[A-Z]/g);
  if (capitals && capitals.length >= 2) {
    aliases.add(capitals.join("").toLowerCase());
  }

  // Punctuation-stripped
  const noPunctuation = canonicalName.replace(/[^a-zA-Z0-9\s]/g, "").toLowerCase().trim();
  if (noPunctuation && noPunctuation !== canonicalName.toLowerCase()) {
    aliases.add(noPunctuation);
  }

  return [...aliases];
}

/**
 * Auto-generate enrichment aliases for all entities in a workspace.
 * Returns the number of new aliases inserted.
 */
export async function enrichEntityAliases(workspaceId: string): Promise<number> {
  let totalInserted = 0;

  type EntityRow = { id: string; canonical_name: string; type: EntityType; slack_user_id: string | null };

  const allEntities = ((await db.execute(sql`
    SELECT id, canonical_name, type, slack_user_id
    FROM entities
    WHERE workspace_id = ${workspaceId}
    ORDER BY canonical_name
  `)) as any).rows as EntityRow[];

  // Pre-fetch Slack display names for person entities with slack_user_id
  const slackUserIds = allEntities
    .filter((e) => e.type === "person" && e.slack_user_id)
    .map((e) => e.slack_user_id!);

  const slackDisplayNames = new Map<string, string>();
  if (slackUserIds.length > 0) {
    const userRows = ((await db.execute(sql`
      SELECT slack_user_id, display_name
      FROM users
      WHERE workspace_id = ${workspaceId}
        AND slack_user_id = ANY(${slackUserIds})
    `)) as any).rows as Array<{ slack_user_id: string; display_name: string }>;
    for (const row of userRows) {
      slackDisplayNames.set(row.slack_user_id, row.display_name);
    }
  }

  for (const entity of allEntities) {
    let newAliases: string[] = [];

    if (entity.type === "person") {
      newAliases = generatePersonAliases(entity.canonical_name);

      if (entity.slack_user_id) {
        const displayName = slackDisplayNames.get(entity.slack_user_id);
        if (displayName && displayName.toLowerCase() !== entity.canonical_name.toLowerCase()) {
          newAliases.push(displayName.toLowerCase());
          const displayParts = displayName.trim().split(/\s+/);
          if (displayParts.length >= 2) {
            newAliases.push(displayParts[0].toLowerCase());
          }
        }
      }
    } else if (entity.type === "company" || entity.type === "project" || entity.type === "product") {
      newAliases = generateOrgAliases(entity.canonical_name);
    }

    for (const alias of newAliases) {
      if (!alias || alias.length < 2) continue;
      try {
        const result = await db
          .insert(entityAliases)
          .values({
            entityId: entity.id,
            alias,
            source: "enrichment",
          })
          .onConflictDoNothing()
          .returning({ id: entityAliases.id });
        if (result.length > 0) totalInserted++;
      } catch {
        // skip individual alias failures
      }
    }
  }

  logger.info(`Alias enrichment complete: ${totalInserted} new aliases for ${allEntities.length} entities`);
  return totalInserted;
}

// ── Entity Merging ──────────────────────────────────────────────────────────

/**
 * Merge multiple loser entities into a single winner entity.
 * Repoints all memory_entities and aliases, then deletes the losers.
 */
export async function mergeEntities(winnerId: string, loserIds: string[]): Promise<void> {
  if (loserIds.length === 0) return;

  await db.transaction(async (tx) => {
    // 1. Repoint memory_entities from losers → winner
    await tx.execute(sql`
      UPDATE memory_entities
      SET entity_id = ${winnerId}
      WHERE entity_id = ANY(${loserIds})
        AND NOT EXISTS (
          SELECT 1 FROM memory_entities me2
          WHERE me2.memory_id = memory_entities.memory_id
            AND me2.entity_id = ${winnerId}
        )
    `);
    // Delete any remaining rows that would conflict (dupes)
    await tx.execute(sql`
      DELETE FROM memory_entities
      WHERE entity_id = ANY(${loserIds})
    `);

    // 2. Move aliases from losers → winner
    await tx.execute(sql`
      UPDATE entity_aliases
      SET entity_id = ${winnerId}
      WHERE entity_id = ANY(${loserIds})
        AND NOT EXISTS (
          SELECT 1 FROM entity_aliases ea2
          WHERE ea2.entity_id = ${winnerId}
            AND ea2.alias_lower = entity_aliases.alias_lower
        )
    `);
    // Delete remaining conflicting aliases
    await tx.execute(sql`
      DELETE FROM entity_aliases
      WHERE entity_id = ANY(${loserIds})
    `);

    // 3. Delete loser entities
    await tx.execute(sql`
      DELETE FROM entities
      WHERE id = ANY(${loserIds})
    `);
  });

  logger.info(`Merged ${loserIds.length} entities into ${winnerId}`);
}

// ── Duplicate Detection ─────────────────────────────────────────────────────

interface DuplicateEntityInfo {
  id: string;
  name: string;
  type: string;
  memoryCount: number;
}

interface DuplicateGroup {
  canonical: string;
  entities: DuplicateEntityInfo[];
}

/**
 * Find groups of entities that are likely duplicates based on:
 * - Same canonical_name (case-insensitive)
 * - Trigram similarity > 0.6 on canonical_name
 */
export async function findDuplicateEntityGroups(workspaceId: string): Promise<DuplicateGroup[]> {
  // Step 1: Find exact case-insensitive duplicates
  const exactDupes = ((await db.execute(sql`
    SELECT
      lower(e.canonical_name) AS canonical_lower,
      e.id,
      e.canonical_name,
      e.type,
      (SELECT COUNT(*) FROM memory_entities me WHERE me.entity_id = e.id)::int AS memory_count
    FROM entities e
    WHERE e.workspace_id = ${workspaceId}
      AND lower(e.canonical_name) IN (
        SELECT lower(canonical_name)
        FROM entities
        WHERE workspace_id = ${workspaceId}
        GROUP BY lower(canonical_name)
        HAVING COUNT(*) > 1
      )
    ORDER BY lower(e.canonical_name), e.created_at
  `)) as any).rows as Array<{
    canonical_lower: string;
    id: string;
    canonical_name: string;
    type: string;
    memory_count: number;
  }>;

  const groups = new Map<string, DuplicateEntityInfo[]>();
  for (const row of exactDupes) {
    if (!groups.has(row.canonical_lower)) {
      groups.set(row.canonical_lower, []);
    }
    groups.get(row.canonical_lower)!.push({
      id: row.id,
      name: row.canonical_name,
      type: row.type,
      memoryCount: row.memory_count,
    });
  }

  // Step 2: Find fuzzy duplicates (trigram similarity > 0.6)
  const fuzzyDupes = ((await db.execute(sql`
    SELECT
      e1.id AS id1, e1.canonical_name AS name1, e1.type AS type1,
      e2.id AS id2, e2.canonical_name AS name2, e2.type AS type2,
      similarity(lower(e1.canonical_name), lower(e2.canonical_name)) AS sim,
      (SELECT COUNT(*) FROM memory_entities me WHERE me.entity_id = e1.id)::int AS count1,
      (SELECT COUNT(*) FROM memory_entities me WHERE me.entity_id = e2.id)::int AS count2
    FROM entities e1
    JOIN entities e2 ON e1.id < e2.id
      AND e1.workspace_id = e2.workspace_id
      AND similarity(lower(e1.canonical_name), lower(e2.canonical_name)) > 0.6
    WHERE e1.workspace_id = ${workspaceId}
      AND lower(e1.canonical_name) != lower(e2.canonical_name)
    ORDER BY sim DESC
    LIMIT 200
  `)) as any).rows as Array<{
    id1: string;
    name1: string;
    type1: string;
    id2: string;
    name2: string;
    type2: string;
    sim: number;
    count1: number;
    count2: number;
  }>;

  for (const row of fuzzyDupes) {
    const groupKey = `fuzzy:${row.name1.toLowerCase()}~${row.name2.toLowerCase()}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    const group = groups.get(groupKey)!;
    if (!group.some((e) => e.id === row.id1)) {
      group.push({ id: row.id1, name: row.name1, type: row.type1, memoryCount: row.count1 });
    }
    if (!group.some((e) => e.id === row.id2)) {
      group.push({ id: row.id2, name: row.name2, type: row.type2, memoryCount: row.count2 });
    }
  }

  const result: DuplicateGroup[] = [];
  for (const [key, ents] of groups) {
    if (ents.length >= 2) {
      result.push({
        canonical: key.startsWith("fuzzy:") ? key.slice(6) : key,
        entities: ents,
      });
    }
  }

  logger.info(`Found ${result.length} duplicate entity groups in workspace ${workspaceId}`);
  return result;
}

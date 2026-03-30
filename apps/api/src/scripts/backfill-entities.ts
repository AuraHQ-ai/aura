import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { generateText, Output } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { entities, entityAliases, memoryEntities } from "@aura/db/schema";
import type { EntityType, MemoryEntityRole } from "@aura/db/schema";
import {
  extractedEntitySchema,
  ENTITY_EXTRACTION_RULES,
} from "../memory/entity-extraction-schema.js";
// Dynamically imported after dotenv loads (entity-resolution.ts statically imports db/client.js)
let disambiguateFuzzyMatches: typeof import("../memory/entity-resolution.js")["disambiguateFuzzyMatches"];

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
const envFile = isProd ? ".env.production" : ".env.local";
config({ path: resolve(repoRoot, envFile) });
if (isProd) console.log("Using .env.production (--prod)");

const { db } = await import("../db/client.js");
({ disambiguateFuzzyMatches } = await import("../memory/entity-resolution.js"));

// ── Config ──────────────────────────────────────────────────────────────────

const BATCH_SIZE = 50;
const CONCURRENCY = 10;
const WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || "default";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required");
  process.exit(1);
}

// ── LLM Setup ───────────────────────────────────────────────────────────────

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const model = anthropic("claude-haiku-4-5-20251001");

const extractionSchema = z.object({
  results: z.array(
    z.object({
      memory_id: z.string(),
      entities: z.array(extractedEntitySchema),
    }),
  ),
});

const SYSTEM_PROMPT = `Extract entity mentions from these memories. For each memory, return the entities mentioned with their type, role, and aliases.

${ENTITY_EXTRACTION_RULES}`;

// ── Entity Resolution with In-Memory Cache ──────────────────────────────────

// Typed cache: "type:name_lower" -> entityId (same-type fast path)
const entityCache = new Map<string, string>();
// Cross-type cache: "name_lower" -> entityId (prevents dupes across types)
const entityByName = new Map<string, string>();

function cacheKey(type: string, name: string): string {
  return `${type}:${name.toLowerCase().trim()}`;
}

function nameKey(name: string): string {
  return name.toLowerCase().trim();
}

type ResultRow = Record<string, any>;

function extractRows(result: unknown): ResultRow[] {
  return ((result as any).rows ?? result) as ResultRow[];
}

function setCache(entityId: string, type: EntityType, name: string): void {
  entityCache.set(cacheKey(type, name), entityId);
  const nk = nameKey(name);
  if (!entityByName.has(nk)) entityByName.set(nk, entityId);
}

async function insertAliases(
  entityId: string,
  type: EntityType,
  canonicalName: string,
  llmAliases: string[],
): Promise<void> {
  const aliasSet = new Set<string>();
  aliasSet.add(canonicalName);

  for (const a of llmAliases) {
    const trimmed = a.trim();
    if (trimmed) aliasSet.add(trimmed);
  }

  for (const alias of aliasSet) {
    try {
      await db
        .insert(entityAliases)
        .values({ entityId, alias, source: "backfill" })
        .onConflictDoNothing();
    } catch {
      // ignore duplicate alias conflicts
    }

    setCache(entityId, type, alias);
  }
}

async function resolveEntityCached(
  name: string,
  type: EntityType,
  aliases: string[],
): Promise<{ entityId: string; isNew: boolean }> {
  const key = cacheKey(type, name);
  const lowerName = nameKey(name);
  if (!lowerName) throw new Error("Entity name cannot be empty");

  // 1a. Same-type cache hit
  const cached = entityCache.get(key);
  if (cached) {
    await insertAliases(cached, type, name, aliases);
    return { entityId: cached, isNew: false };
  }

  // 1b. Same-type alias cache hit
  for (const alias of aliases) {
    const aliasHit = entityCache.get(cacheKey(type, alias));
    if (aliasHit) {
      setCache(aliasHit, type, name);
      await insertAliases(aliasHit, type, name, aliases);
      return { entityId: aliasHit, isNew: false };
    }
  }

  // 1c. Cross-type cache hit (name or aliases)
  const crossHit = entityByName.get(lowerName);
  if (crossHit) {
    setCache(crossHit, type, name);
    await insertAliases(crossHit, type, name, aliases);
    return { entityId: crossHit, isNew: false };
  }
  for (const alias of aliases) {
    const crossAliasHit = entityByName.get(nameKey(alias));
    if (crossAliasHit) {
      setCache(crossAliasHit, type, name);
      await insertAliases(crossAliasHit, type, name, aliases);
      return { entityId: crossAliasHit, isNew: false };
    }
  }

  // 2. DB same-type exact canonical match
  const exactRows = extractRows(
    await db.execute(sql`
      SELECT id FROM entities
      WHERE workspace_id = ${WORKSPACE_ID}
        AND type = ${type}
        AND lower(canonical_name) = ${lowerName}
      LIMIT 1
    `),
  );
  if (exactRows.length > 0) {
    setCache(exactRows[0].id, type, name);
    await insertAliases(exactRows[0].id, type, name, aliases);
    return { entityId: exactRows[0].id, isNew: false };
  }

  // 3. DB same-type alias match
  const aliasRows = extractRows(
    await db.execute(sql`
      SELECT e.id FROM entities e
      JOIN entity_aliases ea ON e.id = ea.entity_id
      WHERE ea.alias_lower = ${lowerName}
        AND e.type = ${type}
        AND e.workspace_id = ${WORKSPACE_ID}
      LIMIT 1
    `),
  );
  if (aliasRows.length > 0) {
    setCache(aliasRows[0].id, type, name);
    await insertAliases(aliasRows[0].id, type, name, aliases);
    return { entityId: aliasRows[0].id, isNew: false };
  }

  // 4. DB cross-type exact canonical match
  const crossExactRows = extractRows(
    await db.execute(sql`
      SELECT id FROM entities
      WHERE workspace_id = ${WORKSPACE_ID}
        AND lower(canonical_name) = ${lowerName}
      LIMIT 1
    `),
  );
  if (crossExactRows.length > 0) {
    setCache(crossExactRows[0].id, type, name);
    await insertAliases(crossExactRows[0].id, type, name, aliases);
    return { entityId: crossExactRows[0].id, isNew: false };
  }

  // 5. DB cross-type alias match
  const crossAliasRows = extractRows(
    await db.execute(sql`
      SELECT e.id FROM entities e
      JOIN entity_aliases ea ON e.id = ea.entity_id
      WHERE ea.alias_lower = ${lowerName}
        AND e.workspace_id = ${WORKSPACE_ID}
      LIMIT 1
    `),
  );
  if (crossAliasRows.length > 0) {
    setCache(crossAliasRows[0].id, type, name);
    await insertAliases(crossAliasRows[0].id, type, name, aliases);
    return { entityId: crossAliasRows[0].id, isNew: false };
  }

  // 6. Trigram fuzzy match — cross-type, LLM disambiguates
  const fuzzyRows = extractRows(
    await db.execute(sql`
      SELECT * FROM (
        SELECT DISTINCT ON (e.id)
          e.id, e.canonical_name, e.type,
          similarity(ea.alias_lower, ${lowerName}) AS sim
        FROM entities e
        JOIN entity_aliases ea ON e.id = ea.entity_id
        WHERE ea.alias_lower % ${lowerName}
          AND e.workspace_id = ${WORKSPACE_ID}
          AND similarity(ea.alias_lower, ${lowerName}) > 0.4
        ORDER BY e.id, sim DESC
      ) sub
      ORDER BY sim DESC
      LIMIT 50
    `),
  );
  if (fuzzyRows.length > 0) {
    const candidates = fuzzyRows
      .sort((a, b) => Number(b.sim) - Number(a.sim))
      .slice(0, 5)
      .map((r) => ({
        entityId: r.id as string,
        canonicalName: r.canonical_name as string,
        type: r.type as string,
        similarity: Number(r.sim),
      }));

    const match = await disambiguateFuzzyMatches(name, type, candidates, model);
    if (match) {
      setCache(match.entityId, type, name);
      await insertAliases(match.entityId, type, name, aliases);
      return { entityId: match.entityId, isNew: false };
    }
  }

  // 7. Create new entity + aliases
  const [newEntity] = await db
    .insert(entities)
    .values({
      workspaceId: WORKSPACE_ID,
      type,
      canonicalName: name,
    })
    .onConflictDoNothing()
    .returning();

  if (newEntity) {
    await insertAliases(newEntity.id, type, name, aliases);
    setCache(newEntity.id, type, name);
    return { entityId: newEntity.id, isNew: true };
  }

  // Conflict on insert — another row exists, retry exact match
  const retryRows = extractRows(
    await db.execute(sql`
      SELECT id FROM entities
      WHERE workspace_id = ${WORKSPACE_ID}
        AND lower(canonical_name) = ${lowerName}
      LIMIT 1
    `),
  );
  if (retryRows.length > 0) {
    setCache(retryRows[0].id, type, name);
    await insertAliases(retryRows[0].id, type, name, aliases);
    return { entityId: retryRows[0].id, isNew: false };
  }

  throw new Error(`Failed to create or find entity: ${name} (${type})`);
}

// ── Concurrency Pool ─────────────────────────────────────────────────────────

async function pool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

// ── Process a single batch ───────────────────────────────────────────────────

async function processBatch(
  batch: Array<{ id: string; content: string }>,
  batchIdx: number,
  totalBatches: number,
): Promise<{ newEntities: number; linked: number; errors: number }> {
  try {
    const memoriesPayload = batch.map((m) => ({
      id: m.id,
      content: m.content,
    }));

    const { output: result } = await generateText({
      model,
      output: Output.object({ schema: extractionSchema }),
      system: SYSTEM_PROMPT,
      prompt: `Memories:\n${JSON.stringify(memoriesPayload)}`,
    });

    if (!result) {
      console.warn(
        `[batch ${batchIdx + 1}/${totalBatches}] LLM returned no output, skipping`,
      );
      return { newEntities: 0, linked: 0, errors: 1 };
    }

    let batchNewEntities = 0;
    let batchLinked = 0;

    const memResults = result.results.filter(
      (r) => r.entities && r.entities.length > 0,
    );

    const allLinks: Array<{
      memoryId: string;
      entityId: string;
      role: MemoryEntityRole;
    }> = [];

    await Promise.all(
      memResults.map(async (memResult) => {
        const resolved = await Promise.all(
          memResult.entities.map(async (entity) => {
            try {
              const { entityId, isNew } = await resolveEntityCached(
                entity.name,
                entity.type,
                entity.aliases,
              );
              if (isNew) batchNewEntities++;
              return { memoryId: memResult.memory_id, entityId, role: entity.role };
            } catch {
              return null;
            }
          }),
        );

        for (const link of resolved) {
          if (link) allLinks.push(link);
        }
      }),
    );

    if (allLinks.length > 0) {
      for (let i = 0; i < allLinks.length; i += 500) {
        await db
          .insert(memoryEntities)
          .values(allLinks.slice(i, i + 500))
          .onConflictDoNothing();
      }
      batchLinked = allLinks.length;
    }

    console.log(
      `[batch ${batchIdx + 1}/${totalBatches}] processed ${batch.length} memories, ` +
        `created ${batchNewEntities} new entities, linked ${batchLinked} memory_entities`,
    );

    return { newEntities: batchNewEntities, linked: batchLinked, errors: 0 };
  } catch (err) {
    console.error(
      `[batch ${batchIdx + 1}/${totalBatches}] ERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { newEntities: 0, linked: 0, errors: 1 };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Entity Backfill Script ===\n");
  console.log(`Concurrency: ${CONCURRENCY} parallel batches of ${BATCH_SIZE}\n`);

  const unlinked = extractRows(
    await db.execute(sql`
      SELECT m.id, m.content
      FROM memories m
      WHERE NOT EXISTS (
        SELECT 1 FROM memory_entities me WHERE me.memory_id = m.id
      )
      ORDER BY m.created_at
    `),
  ) as Array<{ id: string; content: string }>;

  console.log(`Found ${unlinked.length} unlinked memories`);
  if (unlinked.length === 0) {
    console.log("Nothing to do — all memories already have entity links.");
    return;
  }

  const batches: Array<{ items: Array<{ id: string; content: string }>; idx: number }> = [];
  const totalBatches = Math.ceil(unlinked.length / BATCH_SIZE);
  for (let i = 0; i < totalBatches; i++) {
    batches.push({
      items: unlinked.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE),
      idx: i,
    });
  }

  let totalNewEntities = 0;
  let totalLinked = 0;
  let totalErrors = 0;
  const startTime = Date.now();

  await pool(batches, CONCURRENCY, async (batch) => {
    const result = await processBatch(batch.items, batch.idx, totalBatches);
    totalNewEntities += result.newEntities;
    totalLinked += result.linked;
    totalErrors += result.errors;
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Summary ===`);
  console.log(`Elapsed: ${elapsed}s`);
  console.log(`Memories processed: ${unlinked.length}`);
  console.log(`New entities created: ${totalNewEntities}`);
  console.log(`Memory-entity links created: ${totalLinked}`);
  console.log(`Entity cache size: ${entityCache.size} (typed), ${entityByName.size} (cross-type)`);
  console.log(`Batches with errors: ${totalErrors}`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

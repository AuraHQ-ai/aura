import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { generateText, Output } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { entities, entityAliases, memoryEntities } from "@aura/db/schema";
import type { EntityType, MemoryEntityRole } from "@aura/db/schema";

// Load env before importing db client (which reads DATABASE_URL at import time).
// Pass --prod to use .env.production instead of .env.local.
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
const envFile = isProd ? ".env.production" : ".env.local";
config({ path: resolve(repoRoot, envFile) });
if (isProd) console.log("Using .env.production (--prod)");

const { db } = await import("../db/client.js");

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
      entities: z.array(
        z.object({
          name: z.string(),
          type: z.enum([
            "person",
            "company",
            "project",
            "product",
            "channel",
            "technology",
            "concept",
            "location",
          ]),
          role: z.enum(["subject", "object", "mentioned"]),
        }),
      ),
    }),
  ),
});

const SYSTEM_PROMPT = `Extract entity mentions from these memories. For each memory, return the entities mentioned with their type and role.

Entity types: person, company, project, product, channel, technology
Roles: subject (who/what the memory is primarily about), object (secondary entity), mentioned (just referenced)`;

// ── Entity Resolution with In-Memory Cache ──────────────────────────────────

const entityCache = new Map<string, string>();

function cacheKey(type: string, name: string): string {
  return `${type}:${name.toLowerCase().trim()}`;
}

type ResultRow = Record<string, any>;

function extractRows(result: unknown): ResultRow[] {
  return ((result as any).rows ?? result) as ResultRow[];
}

async function resolveEntityCached(
  name: string,
  type: EntityType,
): Promise<{ entityId: string; isNew: boolean }> {
  const key = cacheKey(type, name);
  const cached = entityCache.get(key);
  if (cached) return { entityId: cached, isNew: false };

  const lowerName = name.toLowerCase().trim();
  if (!lowerName) throw new Error("Entity name cannot be empty");

  // 1. Exact canonical match
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
    entityCache.set(key, exactRows[0].id);
    return { entityId: exactRows[0].id, isNew: false };
  }

  // 2. Alias match
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
    entityCache.set(key, aliasRows[0].id);
    return { entityId: aliasRows[0].id, isNew: false };
  }

  // 3. Trigram fuzzy match (>0.4 similarity)
  const fuzzyRows = extractRows(
    await db.execute(sql`
      SELECT e.id FROM entities e
      JOIN entity_aliases ea ON e.id = ea.entity_id
      WHERE ea.alias_lower % ${lowerName}
        AND e.type = ${type}
        AND e.workspace_id = ${WORKSPACE_ID}
        AND similarity(ea.alias_lower, ${lowerName}) > 0.4
      ORDER BY similarity(ea.alias_lower, ${lowerName}) DESC
      LIMIT 1
    `),
  );
  if (fuzzyRows.length > 0) {
    entityCache.set(key, fuzzyRows[0].id);
    return { entityId: fuzzyRows[0].id, isNew: false };
  }

  // 4. Create new entity + alias
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
    // alias_lower is GENERATED ALWAYS — only provide alias
    await db
      .insert(entityAliases)
      .values({
        entityId: newEntity.id,
        alias: name,
        source: "backfill",
      })
      .onConflictDoNothing();

    entityCache.set(key, newEntity.id);
    return { entityId: newEntity.id, isNew: true };
  }

  // Conflict on insert — another row exists, retry exact match
  const retryRows = extractRows(
    await db.execute(sql`
      SELECT id FROM entities
      WHERE workspace_id = ${WORKSPACE_ID}
        AND type = ${type}
        AND lower(canonical_name) = ${lowerName}
      LIMIT 1
    `),
  );
  if (retryRows.length > 0) {
    entityCache.set(key, retryRows[0].id);
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
      // Insert in chunks of 500 to stay within Postgres parameter limits
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
  console.log(`Entity cache size: ${entityCache.size}`);
  console.log(`Batches with errors: ${totalErrors}`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

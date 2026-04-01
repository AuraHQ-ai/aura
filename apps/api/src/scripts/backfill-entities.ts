import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { generateText, Output } from "ai";
import { z } from "zod";
import type { MemoryEntityRole } from "@aura/db/schema";
import {
  extractedEntitySchema,
  ENTITY_EXTRACTION_RULES,
} from "../memory/entity-extraction-schema.js";
import { pool } from "../lib/pool.js";
import { createProgress } from "../lib/progress.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
const envFile = isProd ? ".env.production" : ".env.local";
config({ path: resolve(repoRoot, envFile) });
if (isProd) console.log("Using .env.production (--prod)");

const { db } = await import("../db/client.js");
const { resolveEntities, linkMemoryEntities } = await import(
  "../memory/entity-resolution.js"
);
const { getFastModel } = await import("../lib/ai.js");

// ── Config ──────────────────────────────────────────────────────────────────

const BATCH_SIZE = 50;
const CONCURRENCY = 10;
const WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || "default";

const model = await getFastModel();

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

type ResultRow = Record<string, any>;
function extractRows(result: unknown): ResultRow[] {
  return ((result as any).rows ?? result) as ResultRow[];
}

// ── Process a single batch ───────────────────────────────────────────────────

async function processBatch(
  batch: Array<{ id: string; content: string }>,
  progress: ReturnType<typeof createProgress>,
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
      progress.tick(batch.length);
      return { newEntities: 0, linked: 0, errors: 1 };
    }

    let batchLinked = 0;

    const memResults = result.results.filter(
      (r) => r.entities && r.entities.length > 0,
    );

    for (const memResult of memResults) {
      try {
        const resolved = await resolveEntities(
          memResult.entities.map((e) => ({
            name: e.name,
            type: e.type,
            role: e.role as MemoryEntityRole,
            aliases: e.aliases,
          })),
          WORKSPACE_ID,
          model,
        );

        if (resolved.length > 0) {
          await linkMemoryEntities(memResult.memory_id, resolved);
          batchLinked += resolved.length;
        }
      } catch {
        // entity resolution failures are logged by the live function
      }
    }

    progress.tick(batch.length);
    return { newEntities: 0, linked: batchLinked, errors: 0 };
  } catch (err) {
    progress.tick(batch.length);
    console.error(
      `  ERROR: ${err instanceof Error ? err.message : String(err)}`,
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

  let totalLinked = 0;
  let totalErrors = 0;

  const progress = createProgress(unlinked.length, { label: "memories", logEvery: BATCH_SIZE });

  await pool(batches, CONCURRENCY, async (batch) => {
    const result = await processBatch(batch.items, progress);
    totalLinked += result.linked;
    totalErrors += result.errors;
  });

  console.log(`\n=== Summary ===`);
  progress.done();
  console.log(`Memories processed: ${unlinked.length}`);
  console.log(`Memory-entity links created: ${totalLinked}`);
  console.log(`Batches with errors: ${totalErrors}`);

  console.log(`\n=== Linking Users <-> Entities ===`);

  const linkResult = await db.execute(sql`
    UPDATE users u
    SET entity_id = sub.entity_id
    FROM (
      SELECT DISTINCT ON (u2.id) u2.id AS user_id, e.id AS entity_id
      FROM users u2
      JOIN entity_aliases ea ON ea.alias_lower = lower(u2.display_name)
      JOIN entities e ON e.id = ea.entity_id AND e.type = 'person'
      WHERE u2.workspace_id = ${WORKSPACE_ID}
      ORDER BY u2.id, e.canonical_name
    ) sub
    WHERE u.id = sub.user_id
  `);
  const linkedCount = (linkResult as any).rowCount ?? 0;
  console.log(`Linked ${linkedCount} users -> person entities`);

  const slackResult = await db.execute(sql`
    UPDATE entities e
    SET slack_user_id = u.slack_user_id
    FROM users u
    WHERE u.entity_id = e.id
      AND u.slack_user_id IS NOT NULL
      AND e.slack_user_id IS NULL
  `);
  const slackCount = (slackResult as any).rowCount ?? 0;
  console.log(`Set slack_user_id on ${slackCount} entities from linked users`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

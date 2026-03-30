import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { generateText, Output } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { utilityToScore } from "../memory/utility.js";
import { pool } from "../lib/pool.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
config({ path: resolve(repoRoot, isProd ? ".env.production" : ".env.local") });
if (isProd) console.log("Using .env.production (--prod)");

const { db } = await import("../db/client.js");

const BATCH_SIZE = 50;
const CONCURRENCY = 10;
const DECAY_FACTOR = 0.995;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required");
  process.exit(1);
}

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const model = anthropic("claude-haiku-4-5-20251001");

const classificationSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      utility: z.enum(["high", "medium", "low"]),
    }),
  ),
});

const SYSTEM_PROMPT = `Classify each memory's utility level. Return the memory id and its utility.

- high: decisions, personal facts, business intelligence, key relationships, architecture decisions, product strategy, hiring/org changes, customer feedback, bugs with real impact
- medium: useful context, status updates with substance, meeting notes, feature discussions, general work context
- low: operational noise, routine status checks, trivial scheduling ("let me check", "sure, one sec"), agent self-actions, test messages, ephemeral coordination

Be generous with "high" — if a memory would be useful to recall 3 months from now, it's high.`;

type ResultRow = Record<string, any>;
function extractRows(result: unknown): ResultRow[] {
  return ((result as any).rows ?? result) as ResultRow[];
}

async function processBatch(
  batch: Array<{ id: string; content: string; created_at: string }>,
  batchIdx: number,
  totalBatches: number,
): Promise<{ classified: number; errors: number }> {
  try {
    const payload = batch.map((m) => ({ id: m.id, content: m.content }));

    const { output: result } = await generateText({
      model,
      output: Output.object({ schema: classificationSchema }),
      system: SYSTEM_PROMPT,
      prompt: JSON.stringify(payload),
    });

    if (!result) {
      console.warn(`[batch ${batchIdx + 1}/${totalBatches}] LLM returned no output`);
      return { classified: 0, errors: 1 };
    }

    const classMap = new Map(result.results.map((r) => [r.id, r.utility]));
    let classified = 0;

    for (const mem of batch) {
      const utility = classMap.get(mem.id) ?? "medium";
      const baseScore = utilityToScore(utility);
      const ageMs = Date.now() - new Date(mem.created_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const decayedScore = baseScore * Math.pow(DECAY_FACTOR, ageDays);

      await db.execute(sql`
        UPDATE memories
        SET utility = ${utility},
            relevance_score = ${Math.max(0.01, decayedScore)},
            updated_at = now()
        WHERE id = ${mem.id}
      `);
      classified++;
    }

    console.log(
      `[batch ${batchIdx + 1}/${totalBatches}] classified ${classified} memories`,
    );
    return { classified, errors: 0 };
  } catch (err) {
    console.error(
      `[batch ${batchIdx + 1}/${totalBatches}] ERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { classified: 0, errors: 1 };
  }
}

async function main() {
  console.log("=== Utility Backfill Script ===\n");
  console.log(`Concurrency: ${CONCURRENCY} parallel batches of ${BATCH_SIZE}\n`);

  const allMemories = extractRows(
    await db.execute(sql`
      SELECT id, content, created_at
      FROM memories
      WHERE utility IS NULL
        AND status IN ('current', 'disputed')
      ORDER BY created_at DESC
    `),
  ) as Array<{ id: string; content: string; created_at: string }>;

  console.log(`Found ${allMemories.length} memories without utility classification`);
  if (allMemories.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const batches: Array<{
    items: Array<{ id: string; content: string; created_at: string }>;
    idx: number;
  }> = [];
  const totalBatches = Math.ceil(allMemories.length / BATCH_SIZE);
  for (let i = 0; i < totalBatches; i++) {
    batches.push({
      items: allMemories.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE),
      idx: i,
    });
  }

  let totalClassified = 0;
  let totalErrors = 0;
  const startTime = Date.now();

  await pool(batches, CONCURRENCY, async (batch) => {
    const result = await processBatch(batch.items, batch.idx, totalBatches);
    totalClassified += result.classified;
    totalErrors += result.errors;
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Summary stats
  const stats = extractRows(
    await db.execute(sql`
      SELECT utility, count(*)::int AS c,
        round(avg(relevance_score)::numeric, 3) AS avg_score
      FROM memories
      WHERE status IN ('current', 'disputed')
      GROUP BY utility
      ORDER BY utility
    `),
  );

  console.log(`\n=== Summary ===`);
  console.log(`Elapsed: ${elapsed}s`);
  console.log(`Classified: ${totalClassified}`);
  console.log(`Batches with errors: ${totalErrors}`);
  console.log(`\nDistribution:`);
  for (const row of stats) {
    console.log(`  ${row.utility ?? "null"}: ${row.c} memories (avg score: ${row.avg_score})`);
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

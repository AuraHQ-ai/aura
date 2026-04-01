import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { generateText, Output } from "ai";
import { z } from "zod";
import { importanceToRelevance } from "../memory/importance.js";
import { DECAY_FACTOR } from "../memory/consolidate.js";
import { pool } from "../lib/pool.js";
import { createProgress } from "../lib/progress.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
config({ path: resolve(repoRoot, isProd ? ".env.production" : ".env.local") });
if (isProd) console.log("Using .env.production (--prod)");

const { db } = await import("../db/client.js");
const { getFastModel } = await import("../lib/ai.js");

const BATCH_SIZE = 50;
const CONCURRENCY = 10;

const model = await getFastModel();

const classificationSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      importance: z.number().int().min(1).max(100),
    }),
  ),
});

const SYSTEM_PROMPT = `Rate each memory's importance from 1 to 100. How valuable would it be to recall this memory months from now?

Score anchors:
- 90-100: Business decisions, org changes, key relationships, architecture decisions, product strategy, hiring, customer-impacting incidents
- 70-89: Product discussions, bug reports with real impact, personal facts about team members, strategy context, technical decisions
- 40-69: Status updates with substance, meeting notes, feature discussions, general work context, process documentation
- 20-39: Routine coordination, minor updates, ephemeral context, progress check-ins
- 1-19: Operational noise ("ok thanks", "let me check"), agent self-actions, test messages, trivial scheduling

Be generous — if a memory would be useful to recall in 3 months, score it 70+.
Return the memory id and its importance score.`;

type ResultRow = Record<string, any>;
function extractRows(result: unknown): ResultRow[] {
  return ((result as any).rows ?? result) as ResultRow[];
}

async function processBatch(
  batch: Array<{ id: string; content: string; created_at: string }>,
  progress: ReturnType<typeof createProgress>,
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
      progress.tick(batch.length);
      return { classified: 0, errors: 1 };
    }

    const scoreMap = new Map(result.results.map((r) => [r.id, r.importance]));
    let classified = 0;

    for (const mem of batch) {
      const importance = scoreMap.get(mem.id) ?? 50;
      const baseRelevance = importanceToRelevance(importance);
      const ageMs = Date.now() - new Date(mem.created_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const decayedScore = baseRelevance * Math.pow(DECAY_FACTOR, ageDays);

      await db.execute(sql`
        UPDATE memories
        SET importance = ${importance},
            relevance_score = ${Math.max(0.01, decayedScore)},
            updated_at = now()
        WHERE id = ${mem.id}
      `);
      classified++;
    }

    progress.tick(batch.length);
    return { classified, errors: 0 };
  } catch (err) {
    progress.tick(batch.length);
    console.error(
      `  ERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { classified: 0, errors: 1 };
  }
}

async function main() {
  console.log("=== Importance Backfill Script ===\n");
  console.log(`Concurrency: ${CONCURRENCY} parallel batches of ${BATCH_SIZE}\n`);

  const allMemories = extractRows(
    await db.execute(sql`
      SELECT id, content, created_at
      FROM memories
      WHERE importance IS NULL
        AND status IN ('current', 'disputed')
      ORDER BY created_at DESC
    `),
  ) as Array<{ id: string; content: string; created_at: string }>;

  console.log(`Found ${allMemories.length} memories without importance scores`);
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

  const progress = createProgress(allMemories.length, { label: "memories", logEvery: BATCH_SIZE });

  await pool(batches, CONCURRENCY, async (batch) => {
    const result = await processBatch(batch.items, progress);
    totalClassified += result.classified;
    totalErrors += result.errors;
  });

  const stats = extractRows(
    await db.execute(sql`
      SELECT
        CASE
          WHEN importance >= 90 THEN '90-100'
          WHEN importance >= 70 THEN '70-89'
          WHEN importance >= 40 THEN '40-69'
          WHEN importance >= 20 THEN '20-39'
          ELSE '1-19'
        END AS bucket,
        count(*)::int AS c,
        round(avg(importance)::numeric, 1) AS avg_importance,
        round(avg(relevance_score)::numeric, 3) AS avg_relevance
      FROM memories
      WHERE importance IS NOT NULL AND status IN ('current', 'disputed')
      GROUP BY bucket
      ORDER BY bucket DESC
    `),
  );

  console.log(`\n=== Summary ===`);
  progress.done();
  console.log(`Classified: ${totalClassified}`);
  console.log(`Batches with errors: ${totalErrors}`);
  console.log(`\nDistribution:`);
  for (const row of stats) {
    console.log(`  ${row.bucket}: ${row.c} memories (avg importance: ${row.avg_importance}, avg relevance: ${row.avg_relevance})`);
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

import { db } from "../db/client.js";
import { benchRuns } from "@aura/db/schema";
import { desc, eq, and } from "drizzle-orm";
import type { BenchRunResult, CategoryScore } from "./types.js";
import { BENCH_META_WORKSPACE_ID, ensureBenchMetaWorkspace } from "./workspace.js";

export function aggregateScores(
  rows: Array<{ dataset: string; category: string; scoreType: CategoryScore["scoreType"]; correct: boolean }>,
): CategoryScore[] {
  const buckets = new Map<string, { n: number; nCorrect: number } & Omit<CategoryScore, "score" | "n" | "nCorrect">>();

  for (const row of rows) {
    const key = `${row.dataset}|${row.category}|${row.scoreType}`;
    const b = buckets.get(key) ?? {
      dataset: row.dataset,
      category: row.category,
      scoreType: row.scoreType,
      n: 0,
      nCorrect: 0,
    };
    b.n++;
    if (row.correct) b.nCorrect++;
    buckets.set(key, b);
  }

  return [...buckets.values()].map((b) => ({
    ...b,
    score: b.n > 0 ? b.nCorrect / b.n : 0,
  }));
}

export async function persistBenchRun(result: BenchRunResult): Promise<void> {
  await ensureBenchMetaWorkspace();

  for (const s of result.scores) {
    await db.insert(benchRuns).values({
      workspaceId: BENCH_META_WORKSPACE_ID,
      runId: result.runId,
      dataset: s.dataset,
      category: s.category,
      scoreType: s.scoreType,
      n: s.n,
      nCorrect: s.nCorrect,
      score: s.score,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      generationModel: result.generationModel,
      judgeModel: result.judgeModel,
      embeddingModel: result.embeddingModel,
      corpusHash: result.corpusHash,
      gitSha: result.gitSha,
      prNumber: result.prNumber ?? null,
    });
  }
}

export type PriorScoreRow = {
  category: string;
  dataset: string;
  scoreType: string;
  score: number;
};

/** Latest aggregate per category before this run (for Slack deltas). */
export async function loadPriorScores(
  dataset: string,
  scoreType: string,
  beforeRunId: string,
): Promise<PriorScoreRow[]> {
  const latest = await db
    .select({
      category: benchRuns.category,
      dataset: benchRuns.dataset,
      scoreType: benchRuns.scoreType,
      score: benchRuns.score,
      runId: benchRuns.runId,
      createdAt: benchRuns.createdAt,
    })
    .from(benchRuns)
    .where(
      and(
        eq(benchRuns.workspaceId, BENCH_META_WORKSPACE_ID),
        eq(benchRuns.dataset, dataset),
        eq(benchRuns.scoreType, scoreType),
      ),
    )
    .orderBy(desc(benchRuns.createdAt))
    .limit(500);

  const seen = new Set<string>();
  const out: PriorScoreRow[] = [];
  for (const row of latest) {
    if (row.runId === beforeRunId) continue;
    const key = `${row.dataset}:${row.category}:${row.scoreType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      category: row.category,
      dataset: row.dataset,
      scoreType: row.scoreType,
      score: row.score,
    });
  }
  return out;
}

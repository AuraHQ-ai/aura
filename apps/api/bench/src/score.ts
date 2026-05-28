import { sql } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { benchRuns } from "@aura/db/schema";
import { BENCH_META_WORKSPACE_ID, ensureBenchMetaWorkspace } from "./workspace.js";
import type { BenchAggregateScore, BenchCaseResult, BenchScoreType } from "./types.js";

export function aggregateScores(params: {
  runId: string;
  cases: BenchCaseResult[];
  includeQa: boolean;
}): BenchAggregateScore[] {
  const groups = new Map<string, {
    dataset: string;
    category: string;
    scoreType: BenchScoreType;
    n: number;
    nCorrect: number;
  }>();

  function add(dataset: string, category: string, scoreType: BenchScoreType, correct: boolean): void {
    const key = `${dataset}:${category}:${scoreType}`;
    const group = groups.get(key) ?? { dataset, category, scoreType, n: 0, nCorrect: 0 };
    group.n += 1;
    if (correct) group.nCorrect += 1;
    groups.set(key, group);
  }

  for (const result of params.cases) {
    if (result.retrievalHit !== null) {
      add(result.dataset, result.category, "retrieval_recall_at_15", result.retrievalHit);
    }
    if (params.includeQa && result.qaCorrect !== undefined) {
      add(result.dataset, result.category, "qa_accuracy", result.qaCorrect);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      runId: params.runId,
      ...group,
      score: group.n === 0 ? 0 : group.nCorrect / group.n,
    }))
    .sort((a, b) =>
      a.dataset.localeCompare(b.dataset) ||
      a.category.localeCompare(b.category) ||
      a.scoreType.localeCompare(b.scoreType)
    );
}

export async function attachPriorDeltas(
  aggregates: BenchAggregateScore[],
): Promise<BenchAggregateScore[]> {
  const withDeltas: BenchAggregateScore[] = [];

  for (const aggregate of aggregates) {
    const prior = await db.execute(sql`
      SELECT score
      FROM bench_runs
      WHERE workspace_id = ${BENCH_META_WORKSPACE_ID}
        AND dataset = ${aggregate.dataset}
        AND category = ${aggregate.category}
        AND score_type = ${aggregate.scoreType}
        AND run_id <> ${aggregate.runId}
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const rows = ((prior as any).rows ?? prior) as Array<{ score?: number | string }>;
    const previousScore = rows[0]?.score === undefined ? undefined : Number(rows[0].score);
    withDeltas.push({
      ...aggregate,
      previousScore,
      delta: previousScore === undefined ? undefined : aggregate.score - previousScore,
    });
  }

  return withDeltas;
}

export async function persistAggregates(params: {
  aggregates: BenchAggregateScore[];
  corpusHash: string;
  gitSha?: string;
  durationMs: number;
  generationModel?: string;
  judgeModel?: string;
  embeddingModel?: string;
  prNumber?: number;
}): Promise<void> {
  if (params.aggregates.length === 0) return;
  await ensureBenchMetaWorkspace();

  await db.insert(benchRuns).values(params.aggregates.map((aggregate) => ({
    workspaceId: BENCH_META_WORKSPACE_ID,
    runId: aggregate.runId,
    dataset: aggregate.dataset,
    category: aggregate.category,
    scoreType: aggregate.scoreType,
    n: aggregate.n,
    nCorrect: aggregate.nCorrect,
    score: aggregate.score,
    durationMs: params.durationMs,
    generationModel: params.generationModel,
    judgeModel: params.judgeModel,
    embeddingModel: params.embeddingModel,
    corpusHash: params.corpusHash,
    gitSha: params.gitSha,
    prNumber: params.prNumber,
  })));
}

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
  const byDatasetCategory = new Map<string, BenchCaseResult[]>();
  for (const result of params.cases) {
    const key = `${result.dataset}:${result.category}`;
    const group = byDatasetCategory.get(key) ?? [];
    group.push(result);
    byDatasetCategory.set(key, group);
  }

  const aggregates: BenchAggregateScore[] = [];
  for (const [key, group] of byDatasetCategory) {
    const [dataset, category] = key.split(":") as [BenchAggregateScore["dataset"], string];
    const recallCases = group.filter((result) => result.retrievalHit !== null);
    if (recallCases.length > 0) {
      const nCorrect = recallCases.filter((result) => result.retrievalHit === true).length;
      aggregates.push({
        runId: params.runId,
        dataset,
        category,
        scoreType: "retrieval_recall_at_15",
        n: recallCases.length,
        nCorrect,
        score: nCorrect / recallCases.length,
      });
    }

    if (params.includeQa) {
      const qaCases = group.filter((result) => result.verdict && result.verdict !== "skipped");
      if (qaCases.length > 0) {
        const nCorrect = qaCases.filter((result) =>
          result.verdict === "correct" || result.verdict === "abstain_ok"
        ).length;
        const partialCredit = qaCases.filter((result) => result.verdict === "partial").length * 0.5;
        aggregates.push({
          runId: params.runId,
          dataset,
          category,
          scoreType: "qa_accuracy",
          n: qaCases.length,
          nCorrect,
          score: (nCorrect + partialCredit) / qaCases.length,
        });
      }

      const abstentionCases = group.filter((result) => result.abstention && result.verdict);
      if (abstentionCases.length > 0) {
        const nCorrect = abstentionCases.filter((result) => result.verdict === "abstain_ok").length;
        aggregates.push({
          runId: params.runId,
          dataset,
          category: "abstention",
          scoreType: "abstention_accuracy",
          n: abstentionCases.length,
          nCorrect,
          score: nCorrect / abstentionCases.length,
        });
      }
    }
  }

  return aggregates
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
  metadata?: Record<string, unknown>;
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
    metadata: params.metadata,
  })));
}

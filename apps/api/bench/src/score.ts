/**
 * Aggregate per-case results into category scores, compute deltas against
 * the most recent prior run, and persist to `bench_runs`.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { benchRuns, type NewBenchRun } from "@aura/db/schema";
import { logger } from "../../src/lib/logger.js";
import { BENCH_META_WORKSPACE } from "./workspace.js";
import type {
  BenchRunConfig,
  BenchScore,
  DatasetId,
  PerCaseResult,
  ScoreType,
} from "./types.js";

/**
 * Aggregate per-case results into (dataset, category, scoreType) cells.
 *
 * QA accuracy counts `correct` + `abstain_ok` as wins; `partial` is half
 * credit (we treat it as 0.5 toward `nCorrect`-equivalent for the score
 * field, but the integer `nCorrect` only counts fully-correct).
 *
 * Retrieval recall counts cases where `retrievedRecallHit === true` over
 * cases where it is not null.
 */
export function aggregateScores(
  results: PerCaseResult[],
  durationMsByDataset: Map<DatasetId, number> = new Map(),
): BenchScore[] {
  const groups = new Map<string, PerCaseResult[]>();
  for (const r of results) {
    const key = `${r.dataset}|${r.category}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const out: BenchScore[] = [];
  for (const [key, group] of groups) {
    const [dataset, category] = key.split("|") as [DatasetId, string];

    // QA accuracy lane
    const qaScored = group.filter((r) => r.judgeVerdict !== "skipped");
    if (qaScored.length > 0) {
      const nCorrect = qaScored.filter(
        (r) => r.judgeVerdict === "correct" || r.judgeVerdict === "abstain_ok",
      ).length;
      const partialCredit = qaScored.filter((r) => r.judgeVerdict === "partial").length * 0.5;
      out.push({
        dataset,
        category,
        scoreType: "qa_accuracy",
        n: qaScored.length,
        nCorrect,
        score: (nCorrect + partialCredit) / qaScored.length,
        durationMs: durationMsByDataset.get(dataset),
      });
    }

    // Retrieval recall lane (skip cases with null hit)
    const recallScored = group.filter((r) => r.retrievedRecallHit !== null);
    if (recallScored.length > 0) {
      const nCorrect = recallScored.filter((r) => r.retrievedRecallHit === true).length;
      out.push({
        dataset,
        category,
        scoreType: "retrieval_recall_at_15",
        n: recallScored.length,
        nCorrect,
        score: nCorrect / recallScored.length,
      });
    }

    // Abstention accuracy — extra lane, fires only when the case is an abstention.
    const abstentions = group.filter((r) => r.abstention);
    if (abstentions.length > 0) {
      const nCorrect = abstentions.filter((r) => r.judgeVerdict === "abstain_ok").length;
      out.push({
        dataset,
        category: "abstention",
        scoreType: "abstention_accuracy",
        n: abstentions.length,
        nCorrect,
        score: nCorrect / abstentions.length,
      });
    }
  }
  return out;
}

/**
 * Persist a run's category scores to `bench_runs`.
 *
 * Writes into workspace_id='bench-meta' which is never wiped. One row per
 * (dataset, category, scoreType) so dashboards can pivot freely.
 */
export async function persistRun(
  scores: BenchScore[],
  config: BenchRunConfig,
  ctx: {
    corpusHash: string;
    generationModel: string;
    judgeModel: string;
    embeddingModel: string;
    metadata?: Record<string, unknown>;
    totalDurationMs: number;
    totalCostUsd?: number;
  },
): Promise<void> {
  if (config.dryRun) {
    logger.info("bench: dry-run — skipping bench_runs insert");
    return;
  }
  if (scores.length === 0) {
    logger.warn("bench: no scores to persist (empty corpus?)");
    return;
  }

  const rows: NewBenchRun[] = scores.map((s) => ({
    workspaceId: BENCH_META_WORKSPACE,
    runId: config.runId,
    dataset: s.dataset,
    category: s.category,
    scoreType: s.scoreType,
    n: s.n,
    nCorrect: s.nCorrect,
    score: s.score,
    costUsd: ctx.totalCostUsd ?? null,
    durationMs: s.durationMs ?? ctx.totalDurationMs,
    generationModel: ctx.generationModel,
    judgeModel: ctx.judgeModel,
    embeddingModel: ctx.embeddingModel,
    corpusHash: ctx.corpusHash,
    gitSha: config.gitSha ?? null,
    prNumber: config.prNumber ?? null,
    metadata: ctx.metadata ?? null,
  }));

  await db.insert(benchRuns).values(rows);
  logger.info(`bench: persisted ${rows.length} rows to bench_runs`, {
    runId: config.runId,
  });
}

/**
 * For each (dataset, category, scoreType) in `scores`, look up the most
 * recent prior run and return the delta (current - prior). Used by the
 * Slack reporter and PR comment.
 */
export async function computeDeltas(
  scores: BenchScore[],
  config: BenchRunConfig,
): Promise<Map<string, { prior: number | null; delta: number | null; priorRunId: string | null }>> {
  const out = new Map<string, { prior: number | null; delta: number | null; priorRunId: string | null }>();
  for (const s of scores) {
    const key = `${s.dataset}|${s.category}|${s.scoreType}`;
    try {
      const rows = await db
        .select({
          score: benchRuns.score,
          runId: benchRuns.runId,
        })
        .from(benchRuns)
        .where(
          and(
            eq(benchRuns.dataset, s.dataset),
            eq(benchRuns.category, s.category),
            eq(benchRuns.scoreType, s.scoreType),
            sql`${benchRuns.runId} != ${config.runId}`,
          ),
        )
        .orderBy(desc(benchRuns.createdAt))
        .limit(1);
      const prior = rows[0]?.score ?? null;
      const priorRunId = rows[0]?.runId ?? null;
      out.set(key, {
        prior,
        delta: prior === null ? null : s.score - prior,
        priorRunId,
      });
    } catch (error) {
      logger.warn("bench: delta lookup failed", {
        key,
        error: String(error).slice(0, 200),
      });
      out.set(key, { prior: null, delta: null, priorRunId: null });
    }
  }
  return out;
}

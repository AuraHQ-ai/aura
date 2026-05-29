/**
 * Aggregate per-case results into category scores, compute deltas against
 * the most recent prior run, and persist to `bench_runs`.
 */

import { desc, sql } from "drizzle-orm";
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
 * Retrieval recall is the MEAN per-case evidence-session coverage
 * (`retrievalCoverage`) over cases that have evidence pointers. `nCorrect`
 * counts fully-covered cases (coverage === 1). This makes multi-hop misses
 * visible — a question needing two sessions where one is retrieved scores
 * 0.5 instead of the old binary 1.0.
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

    // Retrieval recall lane — mean evidence-session coverage. We accept the
    // coverage field when present and fall back to the legacy binary hit
    // (0/1) for results recorded before coverage existed (e.g. resumed runs).
    const coverageOf = (r: PerCaseResult): number | null => {
      if (r.retrievalCoverage != null) return r.retrievalCoverage;
      if (r.retrievedRecallHit != null) return r.retrievedRecallHit ? 1 : 0;
      return null;
    };
    const recallScored = group
      .map((r) => coverageOf(r))
      .filter((c): c is number => c !== null);
    if (recallScored.length > 0) {
      const nFull = recallScored.filter((c) => c >= 1).length;
      const meanCoverage =
        recallScored.reduce((acc, c) => acc + c, 0) / recallScored.length;
      out.push({
        dataset,
        category,
        scoreType: "retrieval_recall_at_15",
        n: recallScored.length,
        nCorrect: nFull,
        score: meanCoverage,
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

/** One context-efficiency cell: mean memory-block size over scored cases. */
export interface ContextEfficiencyStat {
  /** Cases that carried a memoryTokens measurement (answerer ran). */
  n: number;
  /** Mean estimated memory-context tokens injected into the answerer. */
  meanTokens: number;
  /** Mean memory-context characters (audits meanTokens). */
  meanChars: number;
  /** Mean number of memories injected. */
  meanCount: number;
}

export interface ContextEfficiency {
  byDataset: Map<DatasetId, ContextEfficiencyStat>;
  overall: ContextEfficiencyStat;
}

/**
 * Aggregate the per-case memory-context size into mean tokens/chars/count, per
 * dataset and overall. This is the mem0-style "quality per token of context"
 * companion to the accuracy lanes: a retrieval/formatter change that lifts QA
 * by a hair while doubling the injected context shows up here as a regression.
 *
 * Cases without a `memoryTokens` value (errored before the answerer ran, or
 * results recorded before this metric existed) are ignored so the mean stays
 * honest on resumed/mixed runs.
 */
export function aggregateContextEfficiency(
  results: PerCaseResult[],
): ContextEfficiency {
  const mean = (rows: PerCaseResult[]): ContextEfficiencyStat => {
    const measured = rows.filter((r) => r.memoryTokens != null);
    const n = measured.length;
    if (n === 0) return { n: 0, meanTokens: 0, meanChars: 0, meanCount: 0 };
    const sum = (pick: (r: PerCaseResult) => number) =>
      measured.reduce((acc, r) => acc + pick(r), 0);
    return {
      n,
      meanTokens: sum((r) => r.memoryTokens ?? 0) / n,
      meanChars: sum((r) => r.memoryChars ?? 0) / n,
      meanCount: sum((r) => r.memoryCount ?? 0) / n,
    };
  };

  const byDataset = new Map<DatasetId, ContextEfficiencyStat>();
  const datasets = new Set<DatasetId>(results.map((r) => r.dataset));
  for (const dataset of datasets) {
    byDataset.set(
      dataset,
      mean(results.filter((r) => r.dataset === dataset)),
    );
  }

  return { byDataset, overall: mean(results) };
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
 * For each (dataset, category, scoreType) in `scores`, look up the most recent
 * comparable prior run and return the delta (current - prior).
 * Comparable means the same corpus and exact sampled case set. This prevents a
 * manual fast/full/category run from becoming the baseline for a different preset.
 *
 * Implementation note: previous versions did one DB roundtrip per score
 * row (O(scoreRows) queries). A medium-subset run produces ~30 score rows,
 * which on Neon's serverless driver is 30 cold-ish roundtrips for what
 * is essentially "give me the latest score per group". Now we issue one
 * query, walk the result newest-first, and keep the first row per key.
 */
export async function computeDeltas(
  scores: BenchScore[],
  config: BenchRunConfig,
  scope: { corpusHash: string; caseSetHash: string },
): Promise<Map<string, { prior: number | null; delta: number | null; priorRunId: string | null }>> {
  const out = new Map<string, { prior: number | null; delta: number | null; priorRunId: string | null }>();
  for (const s of scores) {
    out.set(`${s.dataset}|${s.category}|${s.scoreType}`, {
      prior: null,
      delta: null,
      priorRunId: null,
    });
  }

  if (scores.length === 0) return out;

  try {
    // One scan, newest-first. We cap at 1000 to bound memory; with one row
    // per (dataset, category, scoreType) per run, that's ~30 runs of
    // history per call which is plenty for delta computation.
    const rows = await db
      .select({
        dataset: benchRuns.dataset,
        category: benchRuns.category,
        scoreType: benchRuns.scoreType,
        score: benchRuns.score,
        runId: benchRuns.runId,
      })
      .from(benchRuns)
      .where(sql`
        ${benchRuns.runId} != ${config.runId}
        AND ${benchRuns.corpusHash} = ${scope.corpusHash}
        AND ${benchRuns.metadata}->>'caseSetHash' = ${scope.caseSetHash}
      `)
      .orderBy(desc(benchRuns.createdAt))
      .limit(1000);

    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.dataset}|${row.category}|${row.scoreType}`;
      if (seen.has(key)) continue;
      const current = out.get(key);
      if (!current) continue; // not a key we care about this run
      seen.add(key);

      const matchingScore = scores.find(
        (s) =>
          s.dataset === row.dataset &&
          s.category === row.category &&
          s.scoreType === row.scoreType,
      )!;
      out.set(key, {
        prior: row.score,
        delta: matchingScore.score - row.score,
        priorRunId: row.runId,
      });
    }
  } catch (error) {
    logger.warn("bench: delta lookup failed (continuing with no priors)", {
      error: String(error).slice(0, 200),
    });
  }

  return out;
}

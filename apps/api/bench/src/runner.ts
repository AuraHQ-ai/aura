/**
 * Top-level orchestrator for a memory bench run.
 *
 *   createBenchWorkspace
 *   for each case:
 *     ingest (extract → memories table)
 *     evaluateRetrieval (recall@15)
 *     evaluateQA (constrained answerer + judge)
 *   aggregateScores → persistRun → buildSlackReport
 *   wipeBenchWorkspace (unless --keep)
 *
 * Exposed via two entry points:
 *   - CLI: `pnpm bench:memory` → see `apps/api/src/scripts/bench-memory.ts`
 *   - Cron: nightly → see `apps/api/src/cron/bench-memory.ts`
 */

import { execSync } from "node:child_process";
import {
  BENCH_META_WORKSPACE,
  benchWorkspaceId,
  createBenchWorkspace,
  gcStaleBenchWorkspaces,
  wipeBenchWorkspace,
} from "./workspace.js";
import {
  computeCorpusHash,
  loadDataset,
  sampleFast,
} from "./fixtures.js";
import { ingestCases } from "./ingest.js";
import { evaluateRetrieval } from "./eval-retrieval.js";
import { evaluateQA } from "./eval-qa.js";
import {
  aggregateScores,
  computeDeltas,
  persistRun,
} from "./score.js";
import { buildTextSummary, postReport } from "./report.js";
import {
  getEmbeddingModel,
  getMainModelId,
} from "../../src/lib/ai.js";
import { logger } from "../../src/lib/logger.js";
import type {
  BenchCase,
  BenchRunConfig,
  BenchScore,
  PerCaseResult,
} from "./types.js";

export interface BenchRunOutput {
  runId: string;
  workspaceId: string;
  scores: BenchScore[];
  results: PerCaseResult[];
  deltas: Map<string, { prior: number | null; delta: number | null; priorRunId: string | null }>;
  textSummary: string;
  totalDurationMs: number;
  corpusHash: string;
  slackTs: string | null;
}

const FAST_PER_CATEGORY = 4;

function resolveGitSha(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

async function loadAllCases(config: BenchRunConfig): Promise<BenchCase[]> {
  const all: BenchCase[] = [];
  for (const dataset of config.datasets) {
    const cases = await loadDataset(dataset);
    const filtered = config.category
      ? cases.filter((c) => c.category === config.category)
      : cases;
    const sized =
      config.subset === "fast" ? sampleFast(filtered, FAST_PER_CATEGORY) : filtered;
    logger.info(`bench: loaded ${sized.length} case(s) from ${dataset}`, {
      requested: filtered.length,
      subset: config.subset,
    });
    all.push(...sized);
  }
  return all;
}

/**
 * Run the bench end-to-end and return the in-memory aggregates. The caller
 * (CLI or cron) decides what to do with them (print JSON, post Slack, etc.).
 */
export async function runBench(
  partialConfig: Partial<BenchRunConfig> = {},
): Promise<BenchRunOutput> {
  const runId = partialConfig.runId ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${cryptoSafeId()}`;
  const config: BenchRunConfig = {
    runId,
    datasets: partialConfig.datasets ?? ["toy"],
    subset: partialConfig.subset ?? "full",
    category: partialConfig.category,
    skipIngest: partialConfig.skipIngest ?? false,
    dryRun: partialConfig.dryRun ?? false,
    postSlack: partialConfig.postSlack ?? false,
    judgeModel: partialConfig.judgeModel,
    prNumber: partialConfig.prNumber,
    gitSha: partialConfig.gitSha ?? resolveGitSha(),
  };

  const start = Date.now();
  logger.info(`bench: starting run ${runId}`, {
    datasets: config.datasets,
    subset: config.subset,
    category: config.category ?? "(all)",
  });

  // GC orphans from crashed prior runs (safe, idempotent).
  await gcStaleBenchWorkspaces().catch(() => {});

  const workspaceId = benchWorkspaceId(runId);
  if (!config.dryRun) {
    await createBenchWorkspace(runId);
  }

  const cases = await loadAllCases(config);
  if (cases.length === 0) {
    logger.warn("bench: no cases loaded — bailing");
    return {
      runId,
      workspaceId,
      scores: [],
      results: [],
      deltas: new Map(),
      textSummary: "(no cases — corpus missing?)",
      totalDurationMs: Date.now() - start,
      corpusHash: "empty",
      slackTs: null,
    };
  }

  const corpusHash = await computeCorpusHash(config.datasets);

  if (!config.skipIngest && !config.dryRun) {
    const ing = await ingestCases(cases, workspaceId, (done, total) => {
      if (done % 5 === 0 || done === total) {
        logger.info(`bench: ingest progress`, { done, total });
      }
    });
    logger.info(`bench: ingest complete`, ing);
  }

  // Score each case.
  const results: PerCaseResult[] = [];
  for (const [i, benchCase] of cases.entries()) {
    const caseStart = Date.now();
    const retrieval = await evaluateRetrieval(benchCase, workspaceId);
    let qa: Awaited<ReturnType<typeof evaluateQA>>;
    if (config.dryRun) {
      qa = {
        modelAnswer: "(dry-run)",
        judgeVerdict: "skipped",
        judgeConfidence: 0,
        judgeRationale: "dry-run",
      };
    } else {
      qa = await evaluateQA(benchCase, retrieval.retrieved, {
        judgeModelId: config.judgeModel,
      });
    }
    results.push({
      caseId: benchCase.id,
      dataset: benchCase.source,
      category: benchCase.category,
      question: benchCase.question,
      goldAnswer: benchCase.goldAnswer,
      abstention: benchCase.abstention,
      retrievedMemoryIds: retrieval.retrievedMemoryIds,
      retrievedRecallHit: retrieval.hit,
      modelAnswer: qa.modelAnswer,
      judgeVerdict: qa.judgeVerdict,
      judgeConfidence: qa.judgeConfidence,
      judgeRationale: qa.judgeRationale,
      durationMs: Date.now() - caseStart,
    });
    if ((i + 1) % 10 === 0 || i + 1 === cases.length) {
      logger.info(`bench: scored ${i + 1}/${cases.length}`);
    }
  }

  const totalDurationMs = Date.now() - start;
  const scores = aggregateScores(results);
  const deltas = await computeDeltas(scores, config).catch(() => new Map());

  const generationModel = await getMainModelId();
  const embeddingModelObj: any = await getEmbeddingModel().catch(() => null);
  const embeddingModel =
    embeddingModelObj?.modelId ?? embeddingModelObj?.id ?? "unknown";
  const judgeModel = config.judgeModel ?? generationModel;

  await persistRun(scores, config, {
    corpusHash,
    generationModel,
    judgeModel,
    embeddingModel,
    totalDurationMs,
    metadata: {
      subset: config.subset,
      category: config.category ?? null,
      cases: results.length,
    },
  });

  const summary = buildTextSummary({
    scores,
    deltas,
    config,
    totalDurationMs,
  });

  let slackTs: string | null = null;
  if (config.postSlack) {
    try {
      slackTs = await postReport({
        scores,
        deltas,
        config,
        totalDurationMs,
      });
    } catch (error) {
      logger.warn("bench: Slack post failed (continuing)", {
        error: String(error).slice(0, 200),
      });
    }
  }

  if (!config.dryRun && !partialConfig.skipIngest) {
    // GC this run's workspace — it's already aggregated. The bench-meta
    // workspace is preserved.
    try {
      await wipeBenchWorkspace(workspaceId);
    } catch (error) {
      logger.warn("bench: workspace wipe failed (continuing)", {
        workspaceId,
        error: String(error).slice(0, 200),
      });
    }
  }

  logger.info(`bench: run ${runId} complete in ${totalDurationMs}ms`, {
    cases: results.length,
    scoreRows: scores.length,
  });

  // bench-meta workspace must always exist (we touch it on every run).
  void BENCH_META_WORKSPACE;

  return {
    runId,
    workspaceId,
    scores,
    results,
    deltas,
    textSummary: summary,
    totalDurationMs,
    corpusHash,
    slackTs,
  };
}

function cryptoSafeId(): string {
  // Avoid `node:crypto` import overhead — this only needs collision-resistance
  // inside a single run.
  return Math.random().toString(36).slice(2, 10);
}

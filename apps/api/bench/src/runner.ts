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
  loadExternalCorpus,
  stratifiedSample,
  SUBSET_PER_CATEGORY,
} from "./fixtures.js";
import { ingestCases } from "./ingest.js";
import { evaluateRetrieval } from "./eval-retrieval.js";
import { evaluateQA } from "./eval-qa.js";
import { resolveBenchRunModelIds } from "./models.js";
import {
  aggregateScores,
  computeDeltas,
  persistRun,
} from "./score.js";
import { buildTextSummary, postReport } from "./report.js";
import { getEmbeddingModel } from "../../src/lib/ai.js";
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
  const perCategory = SUBSET_PER_CATEGORY[config.subset];

  if (config.corpusFile) {
    const cases = await loadExternalCorpus(config.corpusFile);
    const filtered = config.category
      ? cases.filter((c) => c.category === config.category)
      : cases;
    const sized = Number.isFinite(perCategory)
      ? stratifiedSample(filtered, perCategory)
      : filtered;
    logger.info(`bench: loaded ${sized.length} case(s) from --corpus-file`, {
      file: config.corpusFile,
      requested: filtered.length,
      subset: config.subset,
    });
    return sized;
  }

  const all: BenchCase[] = [];
  for (const dataset of config.datasets) {
    const cases = await loadDataset(dataset);
    const filtered = config.category
      ? cases.filter((c) => c.category === config.category)
      : cases;
    const sized = Number.isFinite(perCategory)
      ? stratifiedSample(filtered, perCategory)
      : filtered;
    logger.info(`bench: loaded ${sized.length} case(s) from ${dataset}`, {
      requested: filtered.length,
      subset: config.subset,
      perCategory,
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
    subset: partialConfig.subset ?? "medium",
    category: partialConfig.category,
    skipIngest: partialConfig.skipIngest ?? false,
    dryRun: partialConfig.dryRun ?? false,
    postSlack: partialConfig.postSlack ?? false,
    extractionModel: partialConfig.extractionModel,
    answererModel: partialConfig.answererModel,
    judgeModel: partialConfig.judgeModel,
    concurrency: partialConfig.concurrency ?? 2,
    corpusFile: partialConfig.corpusFile,
    prNumber: partialConfig.prNumber,
    gitSha: partialConfig.gitSha ?? resolveGitSha(),
  };

  // Resolve the THREE bench slots through the live DB catalog. Each slot
  // honours its CLI override first, then its env var, then its default
  // tier. We carry the resolved gateway ids forward so bench_runs records
  // exactly what was used — that's what makes cross-run deltas honest
  // when tiers eventually point at a new model.
  const models = await resolveBenchRunModelIds({
    extraction: config.extractionModel,
    answerer: config.answererModel,
    judge: config.judgeModel,
  });
  logger.info(`bench: resolved models`, models);

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

  const corpusHash = await computeCorpusHash(config.datasets, config.corpusFile);

  if (!config.skipIngest && !config.dryRun) {
    const ing = await ingestCases(
      cases,
      workspaceId,
      models.extraction,
      config.concurrency ?? 2,
      (done, total) => {
        if (done % 5 === 0 || done === total) {
          logger.info(`bench: ingest progress`, { done, total });
        }
      },
    );
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
        modelId: models.answerer,
        judgeModelId: models.judge,
      });
    }
    void models.extraction; // recorded on the run row, not used at QA time
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

  const embeddingModelObj: any = await getEmbeddingModel().catch(() => null);
  const embeddingModel =
    embeddingModelObj?.modelId ?? embeddingModelObj?.id ?? "unknown";

  await persistRun(scores, config, {
    corpusHash,
    generationModel: models.answerer,
    judgeModel: models.judge,
    embeddingModel,
    totalDurationMs,
    metadata: {
      subset: config.subset,
      category: config.category ?? null,
      cases: results.length,
      extractionModel: models.extraction,
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

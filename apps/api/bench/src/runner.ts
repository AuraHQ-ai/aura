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
import { createHash } from "node:crypto";
import {
  BENCH_META_WORKSPACE,
  benchWorkspaceId,
  createBenchWorkspace,
  ensureBenchWorkspace,
  gcStaleBenchWorkspaces,
  localBenchWorkspaceId,
  wipeBenchData,
  wipeBenchMemories,
  wipeBenchWorkspace,
} from "./workspace.js";
import {
  computeCorpusHash,
  loadDataset,
  loadExternalCorpus,
  sampleTotal,
  stratifiedSample,
  SUBSET_PER_CATEGORY,
} from "./fixtures.js";
import {
  countUniqueConversations,
  storeMessagesForCases,
} from "./ingest.js";
import { runTimeline } from "./timeline.js";
import { resolveBenchRunModelIds } from "./models.js";
import {
  aggregateContextEfficiency,
  aggregateScores,
  computeDeltas,
  persistRun,
  type ContextEfficiency,
} from "./score.js";
import { buildTextSummary, postReport } from "./report.js";
import { createProgress } from "./progress.js";
import { createCostMeter, type CostStage } from "./cost-meter.js";
import {
  createRunArtifacts,
  readLatestRunId,
  type RunArtifacts,
} from "./artifacts.js";
import type { Dashboard } from "./dashboard.js";
import { getEmbeddingModel } from "../../src/lib/ai.js";
import { logger, setLogFile, closeLogFile } from "../../src/lib/logger.js";
import {
  formatMemV3RetrievalFlags,
  getMemV3RetrievalFlagSnapshot,
  type MemV3RetrievalFlagSnapshot,
} from "../../src/memory/retrieval-flags.js";
import {
  BENCH_STAGE_ORDER,
  type BenchCase,
  type BenchRunConfig,
  type BenchScore,
  type BenchStage,
  type PerCaseResult,
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
  caseSetHash: string;
  slackTs: string | null;
  /** Total USD spent across all stages (0 for dry runs / no-case bails). */
  costUsd: number;
  /** Resolved gateway model ids for the run, or null when no stage ran. */
  models: { extraction: string; answerer: string; judge: string } | null;
  /** Runtime retrieval bisect flags active for this run. */
  retrievalFlags: MemV3RetrievalFlagSnapshot;
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

function computeCaseSetHash(cases: BenchCase[]): string {
  const hash = createHash("sha256");
  for (const c of cases) {
    hash.update(c.source);
    hash.update("\0");
    hash.update(c.id);
    hash.update("\0");
    hash.update(c.category);
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

async function loadAllCases(config: BenchRunConfig): Promise<BenchCase[]> {
  // An explicit --limit wins over the named subset, so you can dial the
  // per-category count up incrementally while iterating.
  const perCategory =
    config.limit && config.limit > 0
      ? config.limit
      : SUBSET_PER_CATEGORY[config.subset];

  if (config.corpusFile) {
    const cases = await loadExternalCorpus(config.corpusFile);
    const filtered = config.category
      ? cases.filter((c) => c.category === config.category)
      : cases;
    const sized = Number.isFinite(perCategory)
      ? stratifiedSample(filtered, perCategory)
      : filtered;
    const capped =
      config.cases && config.cases > 0 ? sampleTotal(sized, config.cases) : sized;
    logger.info(`bench: loaded ${capped.length} case(s) from --corpus-file`, {
      file: config.corpusFile,
      requested: filtered.length,
      subset: config.subset,
      cases: config.cases,
    });
    return capped;
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

  // --cases=N: deterministic TOTAL cap across everything loaded above.
  if (config.cases && config.cases > 0 && all.length > config.cases) {
    const capped = sampleTotal(all, config.cases);
    logger.info(`bench: capped to ${capped.length} total case(s) (--cases)`, {
      requested: all.length,
      cases: config.cases,
    });
    return capped;
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
    limit: partialConfig.limit,
    cases: partialConfig.cases,
    category: partialConfig.category,
    skipMessageEmbeddings: partialConfig.skipMessageEmbeddings ?? false,
    skipIngest: partialConfig.skipIngest ?? false,
    dryRun: partialConfig.dryRun ?? false,
    postSlack: partialConfig.postSlack ?? false,
    extractionModel: partialConfig.extractionModel,
    answererModel: partialConfig.answererModel,
    judgeModel: partialConfig.judgeModel,
    concurrency: partialConfig.concurrency ?? 4,
    scoreConcurrency: partialConfig.scoreConcurrency,
    asOf: partialConfig.asOf ?? true,
    corpusFile: partialConfig.corpusFile,
    prNumber: partialConfig.prNumber,
    gitSha: partialConfig.gitSha ?? resolveGitSha(),
    fromStage: partialConfig.fromStage,
    toStage: partialConfig.toStage,
    benchId: partialConfig.benchId,
    persist: partialConfig.persist,
    reset: partialConfig.reset,
    embedConcurrency: partialConfig.embedConcurrency,
    progress: partialConfig.progress,
    replay: partialConfig.replay,
    resume: partialConfig.resume,
    cancelSignal: partialConfig.cancelSignal,
  };

  const start = Date.now();
  const retrievalFlags = getMemV3RetrievalFlagSnapshot();
  logger.info(`bench: starting run ${runId}`, {
    datasets: config.datasets,
    subset: config.subset,
    category: config.category ?? "(all)",
    retrievalFlags,
  });

  // ── Stage range + workspace selection ──────────────────────────────────────
  // Any staged control (or legacy --skip-ingest) switches the run to a stable,
  // persistent local workspace so data survives between invocations. Otherwise
  // we use the classic ephemeral per-run workspace that gets wiped at the end.
  const fromStage: BenchStage =
    config.fromStage ?? (config.skipIngest ? "score" : "messages");
  const toStage: BenchStage = config.toStage ?? "score";
  const fromIdx = BENCH_STAGE_ORDER.indexOf(fromStage);
  const toIdx = BENCH_STAGE_ORDER.indexOf(toStage);
  const stageRuns = (s: BenchStage): boolean => {
    const i = BENCH_STAGE_ORDER.indexOf(s);
    return i >= fromIdx && i <= toIdx;
  };

  const persistent = Boolean(
    config.persist ||
      config.reset ||
      config.benchId ||
      config.fromStage ||
      config.toStage ||
      config.skipIngest,
  );
  const replay = config.replay ?? "exchange";
  const benchKey =
    config.benchId ??
    `${config.datasets.join("-")}-${config.subset}` +
      `${config.category ? `-${config.category}` : ""}` +
      `${config.limit ? `-l${config.limit}` : ""}` +
      // A total cap selects a different case set, so its extracted memory
      // corpus differs — keep it in its own persistent workspace.
      `${config.cases ? `-c${config.cases}` : ""}` +
      // Per-exchange replay produces a different memory corpus, so keep it in a
      // separate workspace to allow A/B'ing against the session cadence.
      `${replay === "exchange" ? "-px" : ""}`;
  const workspaceId = persistent
    ? localBenchWorkspaceId(benchKey)
    : benchWorkspaceId(runId);

  const tty = config.progress ?? Boolean(process.stdout.isTTY);
  // Extraction (producer) and scoring (consumer) concurrency are decoupled —
  // they overlap in the timeline engine. Scoring is independent LLM work so it
  // defaults higher; both are overridable from the CLI / CI.
  const extractConcurrency = config.concurrency ?? 4;
  const scoreConcurrency = config.scoreConcurrency ?? Math.max(extractConcurrency * 2, 8);
  const embedConcurrency = config.embedConcurrency ?? Math.max(extractConcurrency, 4);

  const cases = await loadAllCases(config);
  if (cases.length === 0) {
    logger.warn("bench: no cases loaded — bailing", {
      hint: "run `pnpm bench:fetch-corpus` to populate the cache directory",
    });
    return {
      runId,
      workspaceId,
      scores: [],
      results: [],
      deltas: new Map(),
      textSummary: "(no cases — corpus missing? Run `pnpm bench:fetch-corpus`.)",
      totalDurationMs: Date.now() - start,
      corpusHash: "empty",
      caseSetHash: "empty",
      slackTs: null,
      costUsd: 0,
      models: null,
      retrievalFlags,
    };
  }

  const corpusHash = await computeCorpusHash(config.datasets, config.corpusFile);
  const caseSetHash = computeCaseSetHash(cases);

  // Dry-run: print what we would do, no DB writes, no LLM calls, no
  // catalog lookup, no expensive loop. CI can validate plumbing for $0.
  if (config.dryRun) {
    logger.info("bench: dry-run — skipping catalog, ingest, retrieval, QA, persist", {
      cases: cases.length,
      datasets: config.datasets,
      subset: config.subset,
      corpusHash,
    });
    return {
      runId,
      workspaceId,
      scores: [],
      results: [],
      deltas: new Map(),
      textSummary: `Dry run: ${cases.length} case(s) loaded across ${config.datasets.join(", ")} (subset=${config.subset}, corpus=${corpusHash.slice(0, 12)}).`,
      totalDurationMs: Date.now() - start,
      corpusHash,
      caseSetHash,
      slackTs: null,
      costUsd: 0,
      models: null,
      retrievalFlags,
    };
  }

  // Past this point we touch Postgres and the AI Gateway. Resolve the three
  // bench slots through the live model catalog only for the stages we'll run
  // (extraction is needed by `extract`; answerer+judge by `score`). Each slot
  // honours its CLI override, then env var, then default tier. Resolved ids
  // are persisted so cross-run deltas stay honest if tiers later repoint.
  const needModels = stageRuns("extract") || stageRuns("score");
  const models = needModels
    ? await resolveBenchRunModelIds({
        extraction: config.extractionModel,
        answerer: config.answererModel,
        judge: config.judgeModel,
      })
    : null;
  if (models) logger.info(`bench: resolved models`, models);

  // ── Workspace setup + stage-scoped wipes ───────────────────────────────────
  if (persistent) {
    await ensureBenchWorkspace(workspaceId);
    if (config.reset || fromStage === "messages") {
      // From scratch: drop all data (messages + memories), keep the row.
      await wipeBenchData(workspaceId);
    } else if (fromStage === "extract") {
      // Reuse messages, re-extract: drop only memories + entities.
      await wipeBenchMemories(workspaceId);
    }
    // fromStage === "score": reuse everything already ingested.
    logger.info("bench: persistent local workspace", {
      workspaceId,
      from: fromStage,
      to: toStage,
      reset: Boolean(config.reset),
    });
  } else {
    // Classic ephemeral run: GC crash orphans + seed a fresh per-run row.
    await gcStaleBenchWorkspaces().catch(() => {});
    await createBenchWorkspace(runId);
  }

  // ── Artifacts + resume + live dashboard setup ──────────────────────────────
  // Resolve the effective run id: a --resume points artifacts at a prior run's
  // directory so we append to its cases.jsonl and skip what's already scored.
  const resumeId =
    config.resume != null
      ? config.resume.length > 0
        ? config.resume
        : readLatestRunId()
      : null;
  const effectiveRunId = resumeId ?? runId;
  const artifacts: RunArtifacts = createRunArtifacts(effectiveRunId);
  // Capture every log line to runs/<id>/run.log while the dashboard owns the TTY.
  setLogFile(artifacts.logPath);
  artifacts.markLatest();
  logger.info("bench: active MEMv3 retrieval flags", {
    flags: retrievalFlags,
    display: formatMemV3RetrievalFlags(retrievalFlags),
  });

  const priorResults: PerCaseResult[] = resumeId ? artifacts.loadCases() : [];
  if (resumeId) {
    logger.info(`bench: resuming run ${resumeId}`, {
      alreadyScored: priorResults.length,
    });
  }

  // Cost meter: stages report (modelId, usage); the meter prices it via the
  // model_pricing table and feeds the dashboard's running $.
  const meter = createCostMeter();

  // TTY → Ink dashboard (dynamically imported so ink/react never load on the
  // Vercel runtime). Non-TTY → per-stage heartbeat fallback.
  // Labels reflect the timeline roles: these tracks run concurrently, not in
  // sequence. `messages` stores raw rows off the critical path; `extract` is the
  // producer advancing the watermark; `score` is the consumer draining
  // releasable questions as the frontier passes them.
  const stageDefs: { name: string; label: string }[] = [];
  if (stageRuns("messages")) stageDefs.push({ name: "messages", label: "messages" });
  if (stageRuns("extract")) stageDefs.push({ name: "extract", label: "extract ▸ producer" });
  if (stageRuns("score")) stageDefs.push({ name: "score", label: "score ◂ consumer" });

  let dashboard: Dashboard | null = null;
  if (tty) {
    try {
      const { createDashboard } = await import("./dashboard.js");
      dashboard = createDashboard(stageDefs);
    } catch (error) {
      logger.warn("bench: dashboard unavailable, using heartbeat", {
        error: String(error).slice(0, 160),
      });
      dashboard = null;
    }
  }

  const recordUsage = (stage: CostStage, modelId: string, usage: unknown) => {
    void meter
      .record(stage, modelId, usage as any)
      .then(() => dashboard?.setCost(meter.snapshot()))
      .catch(() => {});
  };

  /** A stage progress handle backed by either the dashboard or a heartbeat. */
  const makeStage = (name: string, total: number) => {
    if (dashboard) {
      const h = dashboard.stage(name);
      h.start(total);
      return {
        update: (done: number, t?: number) => h.update(done, t),
        done: () => h.done(),
      };
    }
    const p = createProgress(name, total);
    return {
      update: (done: number, t?: number) => p.update(done, t),
      done: () => p.done(),
    };
  };

  let results: PerCaseResult[] = [];
  let scores: BenchScore[] = [];
  let contextEfficiency: ContextEfficiency | null = null;
  let deltas: BenchRunOutput["deltas"] = new Map();
  let slackTs: string | null = null;
  let cancelled = false;
  let summary = "";
  let totalDurationMs = 0;

  try {
    // ── Stage: messages (store + batch-embed raw messages) ───────────────────
    // Off the critical path: retrieval/extraction never read the `messages`
    // table, so this runs concurrently with the timeline (extraction + scoring)
    // and is only awaited before finalizing. We don't gate the watermark on it.
    let messagesPromise: Promise<unknown> | null = null;
    if (stageRuns("messages")) {
      const p = makeStage("messages", countUniqueConversations(cases));
      messagesPromise = storeMessagesForCases(
        cases,
        workspaceId,
        embedConcurrency,
        (done) => p.update(done),
        !config.skipMessageEmbeddings,
      )
        .then((r) => {
          p.done();
          logger.info("bench: messages stage complete", r);
        })
        .catch((error) => {
          p.done();
          logger.warn("bench: messages stage failed (continuing)", {
            error: String(error).slice(0, 200),
          });
        });
    }

    // ── Timeline: extraction (producer) overlapped with scoring (consumer) ────
    // Extraction replays each conversation's assistant replies in corpus-time
    // order; a question is scored the moment its own conversation frontier
    // passes its timestamp, retrieving as-of that instant. Each scored case is
    // appended to cases.jsonl AS it completes (crash/Ctrl-C safe; --resume skips
    // already-scored ids). When only extraction runs (--to=extract) the consumer
    // is idle; when only scoring runs (--from=score) frontiers start at +inf.
    const runExtraction = stageRuns("extract");
    const runScoring = stageRuns("score");

    const doneIds = new Set<string>();
    if (runScoring && priorResults.length > 0) {
      for (const r of priorResults) doneIds.add(r.caseId);
    }

    // Live QA% / recall% tallies (seeded from any resumed results).
    let qaCorrect = 0;
    let qaTotal = 0;
    let recallHit = 0;
    let recallTotal = 0;
    const tally = (r: PerCaseResult) => {
      qaTotal += 1;
      if (r.judgeVerdict === "correct" || r.judgeVerdict === "abstain_ok") {
        qaCorrect += 1;
      }
      // Coverage-based: recallTotal counts evidence cases, recallHit counts
      // FULLY-covered ones. For the single-evidence cases that dominate the
      // corpora this equals the report's mean coverage; for multi-hop cases
      // it's the stricter "all sessions retrieved" rate. Falls back to the
      // legacy binary hit for results recorded before coverage existed.
      const cov =
        r.retrievalCoverage != null
          ? r.retrievalCoverage
          : r.retrievedRecallHit != null
            ? r.retrievedRecallHit
              ? 1
              : 0
            : null;
      if (cov !== null) {
        recallTotal += 1;
        if (cov >= 1) recallHit += 1;
      }
    };
    for (const r of priorResults) tally(r);
    const pushScores = () =>
      dashboard?.setScores({ qaCorrect, qaTotal, recallHit, recallTotal });
    pushScores();

    const extractStage = runExtraction ? makeStage("extract", 0) : null;
    const scoreStage = runScoring ? makeStage("score", cases.length) : null;
    scoreStage?.update(doneIds.size, cases.length);

    const onResult = (result: PerCaseResult): void => {
      artifacts.appendCase(result);

      const qaOk =
        result.judgeVerdict === "correct" || result.judgeVerdict === "abstain_ok";
      if (!qaOk) {
        artifacts.appendFailure({
          caseId: result.caseId,
          dataset: result.dataset,
          category: result.category,
          kind: "qa",
          question: result.question,
          goldAnswer: result.goldAnswer,
          modelAnswer: result.modelAnswer,
          judgeVerdict: result.judgeVerdict,
          judgeRationale: result.judgeRationale,
          retrievedMemoryIds: result.retrievedMemoryIds,
        });
      }
      // Log any case whose evidence sessions weren't fully retrieved —
      // including partial multi-hop coverage (0 < coverage < 1), which the
      // old binary hit silently passed.
      if (result.retrievalCoverage != null && result.retrievalCoverage < 1) {
        artifacts.appendFailure({
          caseId: result.caseId,
          dataset: result.dataset,
          category: result.category,
          kind: "recall",
          question: result.question,
          goldAnswer: result.goldAnswer,
          modelAnswer: result.modelAnswer,
          judgeVerdict: result.judgeVerdict,
          judgeRationale: `coverage ${(result.retrievalCoverage * 100).toFixed(0)}% — ${result.judgeRationale}`,
          retrievedMemoryIds: result.retrievedMemoryIds,
        });
      }

      tally(result);
      pushScores();
    };

    const timeline = await runTimeline({
      cases,
      workspaceId,
      models: models!,
      replay,
      asOf: config.asOf ?? true,
      extractConcurrency,
      scoreConcurrency,
      runExtraction,
      runScoring,
      doneIds,
      priorResults,
      recordUsage,
      onExtractProgress: (done, total) => extractStage?.update(done, total),
      onScoreProgress: (done, total) => scoreStage?.update(done, total),
      onResult,
      cancelSignal: config.cancelSignal,
    });
    extractStage?.done();
    scoreStage?.done();
    cancelled = timeline.cancelled;
    if (runScoring) results = timeline.results;
    logger.info("bench: timeline complete", {
      replay,
      asOf: config.asOf ?? true,
      extractionUnits: timeline.extractionUnitsDone,
      scored: results.length,
      cancelled,
    });

    // Message storage is off the critical path; make sure it lands before we
    // finalize artifacts (so a run that asked for messages actually has them).
    if (messagesPromise) await messagesPromise;

    totalDurationMs = Date.now() - start;

    if (stageRuns("score")) {
      scores = aggregateScores(results);
      deltas = (await computeDeltas(scores, config, { corpusHash, caseSetHash }).catch(
        () => new Map(),
      )) as BenchRunOutput["deltas"];

      const embeddingModelObj: any = await getEmbeddingModel().catch(() => null);
      const embeddingModel =
        embeddingModelObj?.modelId ?? embeddingModelObj?.id ?? "unknown";

      const totalCostUsd = meter.snapshot().usd;

      await persistRun(scores, config, {
        corpusHash,
        generationModel: models!.answerer,
        judgeModel: models!.judge,
        embeddingModel,
        totalDurationMs,
        totalCostUsd,
        metadata: {
          subset: config.subset,
          category: config.category ?? null,
          cases: results.length,
          caseSetHash,
          extractionModel: models!.extraction,
          replay,
          retrievalFlags,
          costUsd: totalCostUsd,
          cancelled,
        },
      });

      contextEfficiency = aggregateContextEfficiency(results);
      summary = buildTextSummary({
        scores,
        deltas,
        config,
        totalDurationMs,
        contextEfficiency,
      });

      if (config.postSlack && !cancelled) {
        try {
          slackTs = await postReport({
            scores,
            deltas,
            config,
            totalDurationMs,
            contextEfficiency,
          });
        } catch (error) {
          logger.warn("bench: Slack post failed (continuing)", {
            error: String(error).slice(0, 200),
          });
        }
      }
    } else {
      summary =
        `Ran stages ${fromStage}→${toStage} on workspace ${workspaceId} ` +
        `(${cases.length} case(s)). Scoring skipped — re-run with --to=score ` +
        `or --from=score to evaluate.`;
      logger.info("bench: scoring stage skipped", { fromStage, toStage });
    }

    // Crash-safe artifacts: summary, scores, manifest (+ already-streamed JSONL).
    const cost = meter.snapshot();
    artifacts.writeScores(scores);
    artifacts.writeSummary(summary);
    artifacts.writeManifest({
      runId: effectiveRunId,
      resumedFrom: resumeId,
      cancelled,
      datasets: config.datasets,
      subset: config.subset,
      cases: config.cases ?? null,
      category: config.category ?? null,
      replay,
      fromStage,
      toStage,
      workspaceId,
      persistent,
      corpusHash,
      caseSetHash,
      gitSha: config.gitSha ?? null,
      retrievalFlags,
      models,
      counts: {
        cases: cases.length,
        scored: results.length,
        scoreRows: scores.length,
      },
      cost: { usd: cost.usd, tokens: cost.tokens, byStage: cost.byStage },
      // Map → plain object so the per-dataset stats survive JSON.stringify.
      contextEfficiency: contextEfficiency
        ? {
            overall: contextEfficiency.overall,
            byDataset: Object.fromEntries(contextEfficiency.byDataset),
          }
        : null,
      totalDurationMs,
    });

    // Only the classic ephemeral run wipes at the end. Persistent local
    // workspaces are intentionally left in place so the next staged run can
    // reuse the data (that's the whole point of --from / --persist).
    if (!persistent) {
      try {
        await wipeBenchWorkspace(workspaceId);
      } catch (error) {
        logger.warn("bench: workspace wipe failed (continuing)", {
          workspaceId,
          error: String(error).slice(0, 200),
        });
      }
    }

    logger.info(
      `bench: run ${effectiveRunId} ${cancelled ? "cancelled" : "complete"} in ${totalDurationMs}ms`,
      {
        cases: results.length,
        scoreRows: scores.length,
        costUsd: Number(cost.usd.toFixed(4)),
        workspaceId,
        persistent,
        artifacts: artifacts.dir,
      },
    );

    // bench-meta workspace must always exist (we touch it on every run).
    void BENCH_META_WORKSPACE;

    return {
      runId: effectiveRunId,
      workspaceId,
      scores,
      results,
      deltas,
      textSummary: summary,
      totalDurationMs,
      corpusHash,
      caseSetHash,
      slackTs,
      costUsd: cost.usd,
      models,
      retrievalFlags,
    };
  } finally {
    dashboard?.stop();
    closeLogFile();
  }
}

function cryptoSafeId(): string {
  // Avoid `node:crypto` import overhead — this only needs collision-resistance
  // inside a single run.
  return Math.random().toString(36).slice(2, 10);
}

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
  countTotalSessions,
  storeMessagesForCases,
  extractMemoriesForCases,
} from "./ingest.js";
import { evaluateRetrieval } from "./eval-retrieval.js";
import { evaluateQA } from "./eval-qa.js";
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
    concurrency: partialConfig.concurrency ?? 2,
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
  logger.info(`bench: starting run ${runId}`, {
    datasets: config.datasets,
    subset: config.subset,
    category: config.category ?? "(all)",
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
  const replay = config.replay ?? "session";
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
  const ingestConcurrency = config.concurrency ?? 2;
  const embedConcurrency = config.embedConcurrency ?? Math.max(ingestConcurrency, 4);

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
  const stageDefs: { name: string; label: string }[] = [];
  if (stageRuns("messages")) stageDefs.push({ name: "messages", label: "messages" });
  if (stageRuns("extract")) stageDefs.push({ name: "extract", label: "extract" });
  if (stageRuns("score")) stageDefs.push({ name: "score", label: "score" });

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
    if (stageRuns("messages")) {
      const p = makeStage("messages", countUniqueConversations(cases));
      const r = await storeMessagesForCases(
        cases,
        workspaceId,
        embedConcurrency,
        (done) => p.update(done),
        !config.skipMessageEmbeddings,
      );
      p.done();
      logger.info("bench: messages stage complete", r);
    }

    // ── Stage: extract (transcript → memories) ───────────────────────────────
    if (stageRuns("extract")) {
      // Extraction work is per-session, so the bar counts sessions, not convos.
      const p = makeStage("extract", countTotalSessions(cases));
      const r = await extractMemoriesForCases(
        cases,
        workspaceId,
        models!.extraction,
        ingestConcurrency,
        (done, total) => p.update(done, total),
        replay,
        (modelId, usage) => recordUsage("extract", modelId, usage),
      );
      p.done();
      logger.info("bench: extract stage complete", { ...r, replay });
    }

    // ── Stage: score (retrieval recall@K + QA) ───────────────────────────────
    // Each case fires a constrained answerer call plus an Opus-class judge
    // call, so the phase is dominated by LLM latency. A bounded worker pool
    // runs them; each result is appended to cases.jsonl AS it completes, so a
    // Ctrl-C (cooperative cancel) or crash still leaves a partial record. On
    // --resume, already-scored case ids are skipped and seeded from disk.
    if (stageRuns("score")) {
      const scoringConcurrency = Math.max(
        1,
        Math.min(config.concurrency ?? 2, cases.length),
      );
      const slots: (PerCaseResult | undefined)[] = new Array(cases.length);
      const doneIds = new Set<string>();
      if (priorResults.length > 0) {
        const byId = new Map(priorResults.map((r) => [r.caseId, r]));
        cases.forEach((c, i) => {
          const pr = byId.get(c.id);
          if (pr) {
            slots[i] = pr;
            doneIds.add(c.id);
          }
        });
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
      for (const r of slots) if (r) tally(r);
      const pushScores = () =>
        dashboard?.setScores({ qaCorrect, qaTotal, recallHit, recallTotal });
      pushScores();

      const p = makeStage("score", cases.length);
      let scored = doneIds.size;
      p.update(scored, cases.length);
      let scoreIdx = 0;

      const scoreWorker = async () => {
        while (true) {
          if (config.cancelSignal?.cancelled) {
            cancelled = true;
            return;
          }
          const i = scoreIdx++;
          if (i >= cases.length) return;
          const benchCase = cases[i];
          if (doneIds.has(benchCase.id)) continue;

          const caseStart = Date.now();
          let result: PerCaseResult;
          try {
            const retrieval = await evaluateRetrieval(
              benchCase,
              workspaceId,
              15,
              (modelId, usage) => recordUsage("retrieve", modelId, usage),
            );
            const qa = await evaluateQA(benchCase, retrieval.retrieved, {
              modelId: models!.answerer,
              judgeModelId: models!.judge,
              onUsage: (stage, modelId, usage) =>
                recordUsage(stage, modelId, usage),
            });
            result = {
              caseId: benchCase.id,
              dataset: benchCase.source,
              category: benchCase.category,
              question: benchCase.question,
              goldAnswer: benchCase.goldAnswer,
              abstention: benchCase.abstention,
              retrievedMemoryIds: retrieval.retrievedMemoryIds,
              retrievedRecallHit: retrieval.hit,
              retrievalCoverage: retrieval.coverage,
              modelAnswer: qa.modelAnswer,
              judgeVerdict: qa.judgeVerdict,
              judgeConfidence: qa.judgeConfidence,
              judgeRationale: qa.judgeRationale,
              memoryTokens: qa.memoryTokens,
              memoryChars: qa.memoryChars,
              memoryCount: qa.memoryCount,
              durationMs: Date.now() - caseStart,
            };
          } catch (error) {
            // Per-case isolation: one bad case must not reject the whole pool.
            logger.warn("bench: case failed (recording skipped verdict)", {
              caseId: benchCase.id,
              error: String(error).slice(0, 200),
            });
            result = {
              caseId: benchCase.id,
              dataset: benchCase.source,
              category: benchCase.category,
              question: benchCase.question,
              goldAnswer: benchCase.goldAnswer,
              abstention: benchCase.abstention,
              retrievedMemoryIds: [],
              retrievedRecallHit: null,
              retrievalCoverage: null,
              modelAnswer: "",
              judgeVerdict: "skipped",
              judgeConfidence: 0,
              judgeRationale: `case error: ${String(error).slice(0, 160)}`,
              durationMs: Date.now() - caseStart,
            };
          }

          slots[i] = result;
          artifacts.appendCase(result);

          const qaOk =
            result.judgeVerdict === "correct" ||
            result.judgeVerdict === "abstain_ok";
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
          scored += 1;
          p.update(scored, cases.length);
        }
      };

      await Promise.all(
        Array.from({ length: scoringConcurrency }, () => scoreWorker()),
      );
      p.done();

      results = slots.filter((r): r is PerCaseResult => Boolean(r));
    }

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

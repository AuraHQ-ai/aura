/**
 * Production-faithful timeline engine for the memory bench.
 *
 * Replaces the old three-sequential-stages model (store ALL → extract ALL →
 * score ALL against the final pool) with a single global timeline that mirrors
 * production end to end:
 *
 *   - Messages arrive over (corpus) time; memory extraction runs as they arrive
 *     — per assistant reply over a sliding window in `exchange` cadence, exactly
 *     like prod's incremental reconciliation.
 *   - Questions arrive over time too. A question asked at instant `T_Q` is
 *     scored the moment the GLOBAL extraction frontier (watermark) passes it —
 *     i.e. once every reply across every conversation with timestamp <= T_Q has
 *     been extracted and reconciled.
 *   - Retrieval is bi-temporal "as-of T_Q": it returns the memory state that was
 *     valid at that instant (`valid_from <= T_Q AND (valid_until IS NULL OR
 *     valid_until > T_Q)`), so a memory superseded LATER is still visible and one
 *     superseded EARLIER is gone. This makes scoring deterministic even though
 *     extraction races ahead of (and overlaps) scoring.
 *
 * Producer (extraction) and consumer (scoring) run concurrently against one
 * shared memory pool. The producer is a bounded-concurrency scheduler that
 * always dispatches the globally-earliest next unit, so the watermark rises
 * smoothly and the consumer can start draining releasable questions early.
 */

import {
  uniqueConversations,
  buildExtractionUnits,
  type ExtractionUnit,
  type ReplayMode,
} from "./ingest.js";
import { evaluateRetrieval } from "./eval-retrieval.js";
import { evaluateQA } from "./eval-qa.js";
import { resolveQuestionDate } from "./fixtures.js";
import { logger } from "../../src/lib/logger.js";
import type { CostStage } from "./cost-meter.js";
import type { BenchCase, PerCaseResult } from "./types.js";

/** Poll cadence for a blocked scoring worker (liveness safety net). */
const CONSUMER_POLL_MS = 100;
const RETRIEVAL_K = 15;

export interface RunTimelineOptions {
  cases: BenchCase[];
  workspaceId: string;
  models: { extraction: string; answerer: string; judge: string };
  replay: ReplayMode;
  /** Bi-temporal as-of retrieval (default true). When false, score against the live pool. */
  asOf: boolean;
  /** Producer (extraction) concurrency — bounds in-flight reconciliation calls. */
  extractConcurrency: number;
  /** Consumer (scoring) concurrency — bounds in-flight answerer/judge calls. */
  scoreConcurrency: number;
  /** Run the extraction producer. When false, the watermark starts at +inf (score-only). */
  runExtraction: boolean;
  /** Run the scoring consumer. When false, only extraction runs (e.g. --to=extract). */
  runScoring: boolean;
  /** Case ids already scored (resume) — skipped by the consumer. */
  doneIds: Set<string>;
  /** Prior results to seed into the returned slots (resume). */
  priorResults: PerCaseResult[];
  recordUsage: (stage: CostStage, modelId: string, usage: unknown) => void;
  /** Extraction progress: (completedUnits, totalUnits). */
  onExtractProgress?: (done: number, total: number) => void;
  /** Scoring progress: (scoredCases, totalCases). */
  onScoreProgress?: (done: number, total: number) => void;
  /** Called as each NEW case is scored — runner does artifacts + tally here. */
  onResult: (result: PerCaseResult, index: number) => void;
  cancelSignal?: { cancelled: boolean };
}

export interface RunTimelineResult {
  results: PerCaseResult[];
  cancelled: boolean;
  extractionUnitsTotal: number;
  extractionUnitsDone: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runTimeline(
  opts: RunTimelineOptions,
): Promise<RunTimelineResult> {
  const {
    cases,
    workspaceId,
    models,
    replay,
    asOf,
    extractConcurrency,
    scoreConcurrency,
    runExtraction,
    runScoring,
    doneIds,
    priorResults,
    recordUsage,
    onExtractProgress,
    onScoreProgress,
    onResult,
    cancelSignal,
  } = opts;

  // ── Producer: build per-conversation extraction units ──────────────────────
  const conversations = uniqueConversations(cases);
  const units: ExtractionUnit[][] = runExtraction
    ? conversations.map((conv) =>
        buildExtractionUnits(conv, workspaceId, models.extraction, replay, (modelId, usage) =>
          recordUsage("extract", modelId, usage),
        ),
      )
    : conversations.map(() => []);
  const extractionUnitsTotal = units.reduce((s, u) => s + u.length, 0);
  let extractionUnitsDone = 0;

  // ── Global watermark over completed extraction units ────────────────────────
  // frontier[c] = corpus timestamp (ms) of conversation c's next UNCOMPLETED
  // unit, or +inf once it's fully extracted. watermark = min frontier. A
  // question at T_Q is releasable once T_Q < watermark (every globally-earlier
  // reply is already reconciled). Score-only runs start at +inf (all present).
  const completed = new Array<number>(conversations.length).fill(0);
  const dispatched = new Array<number>(conversations.length).fill(0);
  const inFlight = new Array<boolean>(conversations.length).fill(false);

  const frontierOf = (c: number): number =>
    completed[c] < units[c].length ? units[c][completed[c]].at.getTime() : Infinity;

  let watermark = Number.POSITIVE_INFINITY;
  const recomputeWatermark = (): void => {
    if (!runExtraction) {
      watermark = Number.POSITIVE_INFINITY;
      return;
    }
    let m = Number.POSITIVE_INFINITY;
    for (let c = 0; c < conversations.length; c++) {
      const f = frontierOf(c);
      if (f < m) m = f;
    }
    watermark = m;
  };
  recomputeWatermark();

  const allExtractionDone = (): boolean => {
    for (let c = 0; c < conversations.length; c++) {
      if (completed[c] < units[c].length) return false;
    }
    return true;
  };

  // ── Producer scheduler: bounded concurrency, globally-earliest-first ─────────
  const runProducer = (): Promise<void> => {
    return new Promise<void>((resolve) => {
      let active = 0;
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const tryDispatch = (): void => {
        while (active < extractConcurrency) {
          if (cancelSignal?.cancelled) break;
          // Pick the available conversation whose next unit has the smallest
          // corpus timestamp (a conv with an in-flight unit is unavailable —
          // units within a conversation must run strictly in order).
          let best = -1;
          let bestAt = Number.POSITIVE_INFINITY;
          for (let c = 0; c < conversations.length; c++) {
            if (inFlight[c]) continue;
            if (dispatched[c] >= units[c].length) continue;
            const at = units[c][dispatched[c]].at.getTime();
            if (at < bestAt) {
              bestAt = at;
              best = c;
            }
          }
          if (best === -1) break;

          const c = best;
          const unit = units[c][dispatched[c]];
          dispatched[c] += 1;
          inFlight[c] = true;
          active += 1;

          void unit
            .run()
            .catch((err) => {
              logger.warn("bench: extraction unit failed", {
                conversation: conversations[c].id,
                error: String(err).slice(0, 200),
              });
            })
            .finally(() => {
              // Advance the frontier even on failure — a failed extraction just
              // means no memory was written; the watermark must not stall.
              completed[c] += 1;
              inFlight[c] = false;
              active -= 1;
              extractionUnitsDone += 1;
              recomputeWatermark();
              onExtractProgress?.(extractionUnitsDone, extractionUnitsTotal);
              if (allExtractionDone() && active === 0) {
                finish();
                return;
              }
              tryDispatch();
            });
        }
        // Nothing left to dispatch and nothing in flight → done (or cancelled).
        if (active === 0 && (allExtractionDone() || cancelSignal?.cancelled)) {
          finish();
        }
      };

      if (allExtractionDone()) {
        finish();
        return;
      }
      tryDispatch();
    });
  };

  // ── Consumer: score releasable questions, overlapping extraction ────────────
  const n = cases.length;
  const slots: (PerCaseResult | undefined)[] = new Array(n);
  if (priorResults.length > 0) {
    const byId = new Map(priorResults.map((r) => [r.caseId, r]));
    cases.forEach((c, i) => {
      const pr = byId.get(c.id);
      if (pr) slots[i] = pr;
    });
  }

  // Questions still to score, in ascending T_Q order. Once the question at the
  // head is releasable (T_Q < watermark), so is every earlier one — so a single
  // monotonic claim pointer is enough, and claim+increment is atomic in JS.
  const pending = cases
    .map((c, index) => ({ index, tq: resolveQuestionDate(c).getTime() }))
    .filter((q) => !doneIds.has(cases[q.index].id))
    .sort((a, b) => a.tq - b.tq);

  let scored = doneIds.size;
  let cancelled = false;
  let claimPtr = 0;

  const scoreOne = async (index: number): Promise<void> => {
    const benchCase = cases[index];
    const caseStart = Date.now();
    // The question is "asked" at its own instant — retrieve as-of that moment.
    const asOfDate = asOf ? resolveQuestionDate(benchCase) : undefined;
    let result: PerCaseResult;
    try {
      const retrieval = await evaluateRetrieval(
        benchCase,
        workspaceId,
        RETRIEVAL_K,
        (modelId, usage) => recordUsage("retrieve", modelId, usage),
        asOfDate,
      );
      const qa = await evaluateQA(benchCase, retrieval.retrieved, {
        modelId: models.answerer,
        judgeModelId: models.judge,
        onUsage: (stage, modelId, usage) => recordUsage(stage, modelId, usage),
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

    slots[index] = result;
    onResult(result, index);
    scored += 1;
    onScoreProgress?.(scored, n);
  };

  const consumer = async (): Promise<void> => {
    while (true) {
      if (cancelSignal?.cancelled) {
        cancelled = true;
        return;
      }
      if (claimPtr >= pending.length) return;
      const head = pending[claimPtr];
      if (head.tq < watermark) {
        // Releasable: claim it (synchronous claim+increment = atomic) and score.
        claimPtr += 1;
        await scoreOne(head.index);
        continue;
      }
      // Not yet releasable — the producer is still working toward this instant.
      await delay(CONSUMER_POLL_MS);
    }
  };

  // ── Run producer + consumers concurrently ───────────────────────────────────
  onExtractProgress?.(0, extractionUnitsTotal);
  onScoreProgress?.(scored, n);

  const producerPromise = runExtraction ? runProducer() : Promise.resolve();
  const consumerPromises = runScoring
    ? Array.from({ length: Math.max(1, Math.min(scoreConcurrency, Math.max(1, pending.length))) }, () =>
        consumer(),
      )
    : [];

  await Promise.all([producerPromise, ...consumerPromises]);

  return {
    results: slots.filter((r): r is PerCaseResult => Boolean(r)),
    cancelled,
    extractionUnitsTotal,
    extractionUnitsDone,
  };
}

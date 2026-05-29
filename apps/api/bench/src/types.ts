/**
 * Type definitions for the memory benchmark harness.
 *
 * Two corpora are supported today (LongMemEval, LoCoMo) but the schema is
 * intentionally minimal so future datasets (#1044–#1046) can plug in without
 * touching the runner.
 */

export type DatasetId = "locomo" | "longmemeval" | "toy";

/**
 * Pipeline stages, in execution order:
 *   messages → store + embed raw messages
 *   extract  → extract memories from transcripts
 *   score    → retrieval recall@K + QA (answerer + judge)
 * The runner can start/stop at any stage (`--from` / `--to`).
 */
export type BenchStage = "messages" | "extract" | "score";
export const BENCH_STAGE_ORDER: BenchStage[] = ["messages", "extract", "score"];

/**
 * A single Q&A case after normalization. Both LoCoMo's `dia_id`-style
 * evidence and LongMemEval's per-session evidence collapse onto
 * `evidenceSessionIds` + `evidenceDiaIds`.
 */
export interface BenchCase {
  /** Stable identifier for the case (used in logs, JSONL artifacts). */
  id: string;
  source: DatasetId;
  /** Per-dataset category, e.g. "temporal", "multi_hop", "abstention". */
  category: string;
  /** The question to ask. */
  question: string;
  /** One or more acceptable answers (multiple = any-of). */
  goldAnswer: string | string[];
  /**
   * True when the correct behaviour is to abstain — there is no answer in
   * memory and the model should say so. LongMemEval's "abstention" axis.
   */
  abstention: boolean;
  /** Conversation history to ingest before the question is asked. */
  sessions: BenchSession[];
  /**
   * Optional: session IDs (e.g. LoCoMo "D1") that contain evidence for the
   * answer. Powers retrieval recall@K when available.
   */
  evidenceSessionIds?: string[];
  /**
   * Optional: per-turn evidence pointers (e.g. LoCoMo "D1:3" = session D1,
   * turn 3). Required for fine-grained retrieval recall.
   */
  evidenceDiaIds?: string[];
  /**
   * Optional: the reference "now" at which the question is asked (LongMemEval
   * `question_date`, e.g. "2023/04/10 (Mon) 23:07"). Temporal-reasoning gold
   * answers ("five months ago") are relative to THIS instant, not the wall
   * clock. Used to anchor both the relative-time rendering of memories and the
   * answerer's notion of the current date. When absent, the harness falls back
   * to the latest session timestamp, then to wall-clock now.
   */
  questionDate?: string;
}

export interface BenchSession {
  /** Per-conversation session identifier (e.g. "D1", "session_2024_01_05"). */
  id: string;
  /** ISO 8601 timestamp at which the session occurred. Used for valid_from. */
  timestamp: string;
  turns: BenchTurn[];
}

export interface BenchTurn {
  /** Stable per-turn ID (e.g. LoCoMo "D1:3"). When absent the loader derives one. */
  diaId?: string;
  /** Either user or assistant. The extractor's reconciliation expects this. */
  role: "user" | "assistant";
  /** Display name to show in the transcript (e.g. "Caroline"). */
  speaker?: string;
  content: string;
}

// ── Run configuration ──────────────────────────────────────────────────────

export interface BenchRunConfig {
  /** Stable identifier for this run (UUID + timestamp). */
  runId: string;
  /** Datasets to load and score. */
  datasets: DatasetId[];
  /**
   * Subset selector:
   *  - "fast"   ≈ 40 Qs, stratified per category. Used by ad-hoc local runs.
   *  - "medium" ≈ 300 Qs, the standard PR / scheduled-CI budget.
   *  - "full"   = the entire vendored corpus (~1,500 LoCoMo + 500 LongMemEval).
   *               Manual runs only — costly.
   */
  subset: "fast" | "medium" | "full";
  /**
   * Optional explicit per-category cap. Overrides `subset` when set — useful
   * for ramping data up in small steps (`--limit=2`, then `5`, then `10`)
   * while iterating on a memory change. 0 or undefined falls back to `subset`.
   */
  limit?: number;
  /**
   * Optional TOTAL case cap across all datasets/categories combined (distinct
   * from `limit`, which is per-category). Applied after loading via a
   * deterministic seeded sample. Used by `--cases=N` for quick smoke runs.
   */
  cases?: number;
  /** Optional category filter (e.g. only "temporal"). */
  category?: string;
  /** Skip ingestion (assumes memories already populated for this runId). */
  skipIngest: boolean;
  /** Don't write to bench_runs, don't post to Slack, don't touch memories. */
  dryRun: boolean;
  /** Post a Block Kit report to Slack channel MEMORY_BENCH_SLACK_CHANNEL. */
  postSlack: boolean;
  /**
   * Override the extraction-stage LLM. Accepts a gateway id
   * (e.g. anthropic/claude-sonnet-4.6) or a tier name (fast | main |
   * escalation). Default tier: main.
   */
  extractionModel?: string;
  /**
   * Override the constrained-answerer LLM. Same format as extractionModel.
   * Default tier: main.
   */
  answererModel?: string;
  /**
   * Override the LLM-judge model. Same format as extractionModel.
   * Default tier: escalation.
   */
  judgeModel?: string;
  /**
   * Number of parallel ingest workers. Memory is bounded — at most this
   * many extraction LLM calls in flight. Defaults to 2.
   */
  concurrency?: number;
  /**
   * Optional path to an external normalized corpus JSON. When set, the
   * runner skips the cache+manifest lookup and loads BenchCase[] directly
   * from this file. Useful for one-off experiments without committing or
   * fetching anything.
   */
  corpusFile?: string;
  /** PR number (CI populates this; nightly leaves it null). */
  prNumber?: number;
  /** Git SHA of HEAD at run time. */
  gitSha?: string;

  // ── Staged local-dev controls ──────────────────────────────────────────────
  /**
   * First stage to run (inclusive). Defaults to "messages" (full pipeline).
   * Using any stage control switches the run to a persistent local workspace
   * so data survives between invocations.
   */
  fromStage?: BenchStage;
  /** Last stage to run (inclusive). Defaults to "score". */
  toStage?: BenchStage;
  /**
   * Stable workspace key for staged local runs. Defaults to a key derived
   * from datasets+subset(+category). Pick the same id across runs to reuse
   * ingested data.
   */
  benchId?: string;
  /**
   * Use a persistent workspace and DON'T wipe it at the end (so later stages
   * can reuse the data). Implied by any of fromStage/toStage/benchId/reset.
   */
  persist?: boolean;
  /** Wipe the persistent workspace's data before running (start from scratch). */
  reset?: boolean;
  /** Number of parallel embedding/message workers. Defaults to `concurrency`. */
  embedConcurrency?: number;
  /** Force the TTY progress bar on/off. Defaults to stdout.isTTY. */
  progress?: boolean;
  /**
   * Extraction replay cadence:
   *  - "session"  (default): one extraction per session over the full session
   *    transcript. Cheap; a good approximation when benchmarking retrieval.
   *  - "exchange": one extraction per assistant turn over the accumulating
   *    last-30-message window — mirrors production's per-reply cadence and
   *    incremental reconciliation. Faithful but multiplies extraction LLM
   *    cost by ~(turns ÷ 2) per session.
   */
  replay?: "session" | "exchange";
  /**
   * Resume a prior run: skip cases already recorded in that run's
   * `cases.jsonl` and append new results to the same run directory. An empty
   * string means "resume the latest run" (via the `runs/latest` pointer).
   * Pairs naturally with `--from=score` since memories survive in the
   * persistent workspace.
   */
  resume?: string;
  /**
   * Cooperative cancellation handle. The CLI installs a SIGINT handler that
   * flips `cancelled` to true; the score loop checks it between cases, drains
   * in-flight work, then persists partial results. Not serialized.
   */
  cancelSignal?: { cancelled: boolean };
}

// ── Score aggregation ──────────────────────────────────────────────────────

export type ScoreType =
  | "qa_accuracy"
  | "retrieval_recall_at_15"
  | "abstention_accuracy";

/**
 * Aggregated bench score for one (dataset, category, scoreType) cell.
 * Mirrors the structure of the `bench_runs` row but kept in memory until
 * the run completes so we can do delta math against priors before writing.
 */
export interface BenchScore {
  dataset: DatasetId;
  category: string;
  scoreType: ScoreType;
  n: number;
  nCorrect: number;
  score: number;
  costUsd?: number;
  durationMs?: number;
}

export interface PerCaseResult {
  caseId: string;
  dataset: DatasetId;
  category: string;
  question: string;
  goldAnswer: string | string[];
  abstention: boolean;
  retrievedMemoryIds: string[];
  retrievedRecallHit: boolean | null;
  /**
   * Fraction (0..1) of the case's evidence sessions that are represented in
   * the retrieved set. null when the case has no evidence pointers. This is
   * the coverage-based recall signal: a multi-hop question citing two evidence
   * sessions where only one is retrieved scores 0.5, surfacing the gap that
   * the old binary `retrievedRecallHit` (any-session = 1.0) hid.
   */
  retrievalCoverage?: number | null;
  modelAnswer: string;
  judgeVerdict: "correct" | "partial" | "incorrect" | "abstain_ok" | "skipped";
  judgeConfidence: number;
  judgeRationale: string;
  /**
   * Estimated token count of the retrieved-memory block injected into the
   * answerer (~4 chars/token). The context-efficiency signal: quality per
   * token of memory context, mirroring mem0's token-efficiency reporting.
   * Model-independent so cross-run deltas aren't confounded by model repoints.
   * Undefined for cases that errored before the answerer ran.
   */
  memoryTokens?: number;
  /** Exact character count of that memory block (audits `memoryTokens`). */
  memoryChars?: number;
  /** Number of memories injected into the answerer prompt. */
  memoryCount?: number;
  durationMs: number;
  costUsd?: number;
}

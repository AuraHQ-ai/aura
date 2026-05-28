/**
 * Type definitions for the memory benchmark harness.
 *
 * Two corpora are supported today (LongMemEval, LoCoMo) but the schema is
 * intentionally minimal so future datasets (#1044–#1046) can plug in without
 * touching the runner.
 */

export type DatasetId = "locomo" | "longmemeval" | "toy";

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
  /** "fast" = ~40 Qs for PR gate; "full" = whole vendored subset. */
  subset: "fast" | "full";
  /** Optional category filter (e.g. only "temporal"). */
  category?: string;
  /** Skip ingestion (assumes memories already populated for this runId). */
  skipIngest: boolean;
  /** Don't write to bench_runs, don't post to Slack, don't touch memories. */
  dryRun: boolean;
  /** Post a Block Kit report to Slack channel MEMORY_BENCH_SLACK_CHANNEL. */
  postSlack: boolean;
  /** Override the LLM-judge model id. Default: same as main model. */
  judgeModel?: string;
  /** PR number (CI populates this; nightly leaves it null). */
  prNumber?: number;
  /** Git SHA of HEAD at run time. */
  gitSha?: string;
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
  modelAnswer: string;
  judgeVerdict: "correct" | "partial" | "incorrect" | "abstain_ok" | "skipped";
  judgeConfidence: number;
  judgeRationale: string;
  durationMs: number;
  costUsd?: number;
}

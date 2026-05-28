import type { Memory } from "@aura/db/schema";
import type { BenchModels } from "./models.js";

export type BenchSource = "locomo" | "longmemeval" | "toy";

export type DatasetId = "toy" | "longmemeval" | "locomo";

export type BenchSubset = "fast" | "medium" | "full";

export type BenchDataset = "locomo" | "lme" | "both" | "toy";

export type BenchCase = {
  id: string;
  source: BenchSource;
  category: string;
  question: string;
  goldAnswer: string | string[];
  abstention: boolean;
  sessions: Array<{
    id: string;
    timestamp: string;
    turns: Array<{
      role: "user" | "assistant";
      content: string;
      diaId?: string;
      speaker?: string;
    }>;
  }>;
  evidenceSessionIds?: string[];
  evidenceDiaIds?: string[];
};

export type BenchRunConfig = {
  dataset: BenchDataset;
  subset: BenchSubset;
  categoryFilter?: string;
  /** Normalized BenchCase[] JSON for ad-hoc experiments */
  corpusFile?: string;
  skipIngest: boolean;
  dryRun: boolean;
  /** false = skip QA judge; string = judge model id */
  judge: boolean | string;
  postSlack: boolean;
  prNumber?: number;
  concurrency: number;
  models?: Partial<BenchModels>;
};

export type JudgeVerdict = "correct" | "partial" | "incorrect" | "abstain_ok" | "skipped";

export type PerCaseResult = {
  caseId: string;
  dataset: string;
  category: string;
  question: string;
  goldAnswer: string;
  abstention: boolean;
  retrievedMemoryIds: string[];
  retrievedRecallHit: boolean | null;
  modelAnswer: string;
  judgeVerdict: JudgeVerdict;
  judgeConfidence: number;
  judgeRationale: string;
  durationMs: number;
};

export type CategoryScore = {
  dataset: string;
  category: string;
  scoreType:
    | "qa_accuracy"
    | "retrieval_recall_at_15"
    | "abstention_accuracy";
  n: number;
  nCorrect: number;
  score: number;
  deltaPp?: number;
};

export type BenchRunResult = {
  ok: boolean;
  runId: string;
  workspaceId: string;
  gitSha?: string;
  corpusHash: string;
  scores: CategoryScore[];
  cases: PerCaseResult[];
  models: BenchModels;
  costUsd: number;
  durationMs: number;
  embeddingModel: string;
  prNumber?: number;
  error?: string;
};

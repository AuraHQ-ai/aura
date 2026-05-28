export type DatasetId = "toy" | "longmemeval" | "locomo";
export type BenchDataset = "toy" | "lme" | "longmemeval" | "locomo" | "both";
export type BenchSubset = "fast" | "medium" | "full";
export type BenchScoreType =
  | "retrieval_recall_at_15"
  | "qa_accuracy"
  | "abstention_accuracy";

export interface BenchTurn {
  role: "user" | "assistant";
  content: string;
  diaId?: string;
  speaker?: string;
}

export interface BenchSession {
  id: string;
  timestamp: string;
  turns: BenchTurn[];
}

export interface BenchCase {
  id: string;
  source: DatasetId;
  category: string;
  question: string;
  goldAnswer: string | string[];
  abstention: boolean;
  sessions: BenchSession[];
  evidenceSessionIds?: string[];
  evidenceDiaIds?: string[];
}

export interface BenchRunConfig {
  dataset: BenchDataset;
  subset: BenchSubset;
  category?: string;
  skipIngest: boolean;
  dryRun: boolean;
  json: boolean;
  postSlack: boolean;
  judge?: string | false;
  extractionModel?: string;
  answerModel?: string;
  corpusFile?: string;
  concurrency?: number;
  prNumber?: number;
}

export interface BenchCaseResult {
  caseId: string;
  dataset: DatasetId;
  category: string;
  retrievedMemoryIds: string[];
  retrievalHit: boolean | null;
  abstention: boolean;
  answer?: string;
  verdict?: "correct" | "partial" | "incorrect" | "abstain_ok" | "skipped";
  qaCorrect?: boolean;
  rationale?: string;
}

export interface BenchAggregateScore {
  runId: string;
  dataset: DatasetId;
  category: string;
  scoreType: BenchScoreType;
  n: number;
  nCorrect: number;
  score: number;
  previousScore?: number;
  delta?: number;
}

export interface BenchRunResult {
  ok: boolean;
  runId: string;
  workspaceId: string;
  corpusHash: string;
  gitSha?: string;
  durationMs: number;
  aggregates: BenchAggregateScore[];
  cases: BenchCaseResult[];
  error?: string;
}

export type BenchSource = "locomo" | "longmemeval" | "toy";

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
    turns: Array<{ role: "user" | "assistant"; content: string }>;
  }>;
  /** Session or dia_ids used for retrieval recall@K */
  evidenceSessionIds?: string[];
};

export type BenchSubset = "fast" | "full";

export type BenchDataset = "locomo" | "lme" | "both" | "toy";

export type BenchRunConfig = {
  runId: string;
  workspaceId: string;
  dataset: BenchDataset;
  subset: BenchSubset;
  categoryFilter?: string;
  skipIngest: boolean;
  dryRun: boolean;
  judge: boolean;
  postSlack: boolean;
  prNumber?: number;
  concurrency: number;
};

export type CategoryScore = {
  dataset: string;
  category: string;
  scoreType: "qa_accuracy" | "retrieval_recall_at_15";
  n: number;
  nCorrect: number;
  score: number;
};

export type BenchRunResult = {
  runId: string;
  gitSha: string;
  corpusHash: string;
  scores: CategoryScore[];
  costUsd: number;
  durationMs: number;
  generationModel: string;
  judgeModel?: string;
  embeddingModel: string;
  prNumber?: number;
};

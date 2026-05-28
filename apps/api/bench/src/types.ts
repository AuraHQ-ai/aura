export type BenchDataset = "lme" | "locomo" | "both";
export type BenchSubset = "fast" | "full";
export type BenchScoreType = "retrieval_recall_at_15" | "qa_accuracy";

export interface BenchTurn {
  role: "user" | "assistant";
  content: string;
  diaId?: string;
}

export interface BenchSession {
  id: string;
  timestamp: string;
  turns: BenchTurn[];
}

export interface BenchCase {
  id: string;
  source: "locomo" | "longmemeval";
  category: string;
  question: string;
  goldAnswer: string | string[];
  abstention: boolean;
  sessions: BenchSession[];
  evidenceSessionIds?: string[];
  evidenceDiaIds?: string[];
}

export interface BenchManifest {
  corpusHash: string;
  generatedAt: string;
  datasets: Array<{
    name: "longmemeval" | "locomo";
    file: string;
    license: string;
    sourceUrl: string;
    cases: number;
    included: boolean;
  }>;
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
  prNumber?: number;
}

export interface BenchCaseResult {
  caseId: string;
  dataset: string;
  category: string;
  retrievedMemoryIds: string[];
  retrievalHit: boolean | null;
  answer?: string;
  verdict?: "correct" | "partial" | "incorrect" | "abstain_ok";
  qaCorrect?: boolean;
  rationale?: string;
}

export interface BenchAggregateScore {
  runId: string;
  dataset: string;
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

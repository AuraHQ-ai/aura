import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { loadCases, loadManifest, corpusHashForCases } from "./fixtures.js";
import {
  createBenchWorkspace,
  cleanupStaleBenchWorkspaces,
  wipeBenchWorkspace,
} from "./workspace.js";
import { ingestCases } from "./ingest.js";
import { evalRetrievalRecall } from "./eval-retrieval.js";
import { answerFromMemories, judgeAnswer } from "./eval-qa.js";
import { aggregateScores, persistBenchRun, loadPriorScores } from "./score.js";
import { postBenchSlackReport } from "./report.js";
import type { BenchRunConfig, BenchRunResult } from "./types.js";
import { getMainModelId } from "../lib/ai.js";
import { logger } from "../lib/logger.js";

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export async function runMemoryBench(config: BenchRunConfig): Promise<BenchRunResult> {
  const start = Date.now();
  await cleanupStaleBenchWorkspaces();

  const cases = loadCases({
    dataset: config.dataset,
    subset: config.subset,
    category: config.categoryFilter,
  });

  if (cases.length === 0) {
    throw new Error("No benchmark cases loaded — check dataset and corpus files");
  }

  const manifest = loadManifest();
  const corpusHash = corpusHashForCases(cases) || manifest.corpus_hash;
  const runId = config.runId?.trim() ? config.runId.trim() : randomUUID().slice(0, 8);
  const workspaceId = await createBenchWorkspace(runId);

  logger.info(`Memory bench starting`, {
    runId,
    workspaceId,
    cases: cases.length,
    skipIngest: config.skipIngest,
  });

  try {
    if (!config.skipIngest && !config.dryRun) {
      await ingestCases(cases, workspaceId, config.concurrency);
    }

    const evalRows: Array<{
      dataset: string;
      category: string;
      scoreType: "qa_accuracy" | "retrieval_recall_at_15";
      correct: boolean;
    }> = [];

    for (const c of cases) {
      const dataset = c.source === "longmemeval" ? "longmemeval" : c.source;

      if (!config.dryRun) {
        const recallHit = await evalRetrievalRecall(c, workspaceId);
        evalRows.push({
          dataset,
          category: c.category,
          scoreType: "retrieval_recall_at_15",
          correct: recallHit,
        });
      }

      if (config.judge && !config.dryRun) {
        const { answer, retrievedCount } = await answerFromMemories(c, workspaceId);
        let qaCorrect = false;
        if (c.abstention && retrievedCount === 0) {
          qaCorrect = true;
        } else {
          const judged = await judgeAnswer(c, answer);
          qaCorrect = judged.correct;
        }
        evalRows.push({
          dataset,
          category: c.category,
          scoreType: "qa_accuracy",
          correct: qaCorrect,
        });
      }
    }

    const scores = aggregateScores(evalRows);
    const genModel = await getMainModelId();
    const embModel = process.env.MODEL_EMBEDDING ?? "openai/text-embedding-3-small";

    const result: BenchRunResult = {
      runId,
      gitSha: gitSha(),
      corpusHash,
      scores,
      costUsd: 0,
      durationMs: Date.now() - start,
      generationModel: genModel,
      judgeModel: config.judge ? genModel : undefined,
      embeddingModel: embModel,
    };

    if (!config.dryRun) {
      await persistBenchRun({ ...result, prNumber: config.prNumber });
    }

    if (config.postSlack && !config.dryRun) {
      const priors = await loadPriorScores("longmemeval", "qa_accuracy", runId);
      await postBenchSlackReport(result, priors);
    }

    return { ...result, prNumber: config.prNumber };
  } finally {
    if (!config.dryRun) {
      await wipeBenchWorkspace(workspaceId);
    }
  }
}

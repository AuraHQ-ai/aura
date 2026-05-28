import { execFileSync } from "node:child_process";
import { loadBenchCases, computeCorpusHash } from "./fixtures.js";
import { benchWorkspaceId, makeRunId } from "./workspace-id.js";
import {
  createBenchWorkspace,
  cleanupStaleBenchWorkspaces,
  wipeBenchWorkspace,
} from "./workspace.js";
import { ingestCases } from "./ingest.js";
import { evaluateRetrieval } from "./eval-retrieval.js";
import { answerFromMemories, judgeAnswer } from "./eval-qa.js";
import {
  aggregateScores,
  attachPriorDeltas,
  loadAllPriorScores,
  persistBenchRun,
} from "./score.js";
import { postBenchSlackReport } from "./report.js";
import type { BenchRunConfig, BenchRunResult, PerCaseResult } from "./types.js";
import { resolveBenchModels } from "./models.js";
import { logger } from "../lib/logger.js";

function gitSha(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

export async function runMemoryBench(config: BenchRunConfig): Promise<BenchRunResult> {
  const started = Date.now();
  const runId = makeRunId();
  const workspaceId = benchWorkspaceId(runId);
  const models = resolveBenchModels(config.models ?? {});

  const cases = await loadBenchCases({
    dataset: config.dataset,
    subset: config.subset,
    category: config.categoryFilter,
    corpusFile: config.corpusFile,
  });

  const corpusHash = await computeCorpusHash({
    dataset: config.dataset,
    corpusFile: config.corpusFile,
  });

  if (cases.length === 0) {
    return {
      ok: false,
      runId,
      workspaceId,
      corpusHash: "none",
      scores: [],
      cases: [],
      models,
      costUsd: 0,
      durationMs: Date.now() - started,
      embeddingModel: process.env.MODEL_EMBEDDING ?? "openai/text-embedding-3-small",
      error: "No cases loaded — run pnpm --filter aura-api bench:fetch-corpus",
    };
  }

  if (config.dryRun) {
    return {
      ok: true,
      runId,
      workspaceId,
      gitSha: gitSha(),
      corpusHash,
      scores: [],
      cases: [],
      models,
      costUsd: 0,
      durationMs: Date.now() - started,
      embeddingModel: process.env.MODEL_EMBEDDING ?? "openai/text-embedding-3-small",
      prNumber: config.prNumber,
    };
  }

  logger.info("Memory bench starting", {
    runId,
    workspaceId,
    cases: cases.length,
    models,
  });

  try {
    await cleanupStaleBenchWorkspaces();
    await createBenchWorkspace(runId);

    if (!config.skipIngest) {
      await ingestCases(cases, workspaceId, models.extraction, config.concurrency);
    }

    const caseResults: PerCaseResult[] = [];
    const judgeModelId =
      config.judge === false
        ? null
        : typeof config.judge === "string"
          ? config.judge
          : models.judge;

    for (const benchCase of cases) {
      const caseStart = Date.now();
      const dataset =
        benchCase.source === "longmemeval"
          ? "longmemeval"
          : benchCase.source === "locomo"
            ? "locomo"
            : benchCase.source;

      const { retrieved, hit } = await evaluateRetrieval(benchCase, workspaceId);

      let modelAnswer = "";
      let judgeVerdict: PerCaseResult["judgeVerdict"] = judgeModelId ? "skipped" : "skipped";
      let judgeConfidence = 0;
      let judgeRationale = "";

      if (judgeModelId) {
        modelAnswer = await answerFromMemories(benchCase, retrieved, models.answerer);
        const judged = await judgeAnswer({
          benchCase,
          answer: modelAnswer,
          modelId: judgeModelId,
        });
        judgeVerdict = judged.verdict;
        judgeConfidence = judged.confidence;
        judgeRationale = judged.rationale;
      }

      caseResults.push({
        caseId: benchCase.id,
        dataset,
        category: benchCase.category,
        question: benchCase.question,
        goldAnswer:
          typeof benchCase.goldAnswer === "string"
            ? benchCase.goldAnswer
            : benchCase.goldAnswer.join(" | "),
        abstention: benchCase.abstention,
        retrievedMemoryIds: retrieved.map((m) => m.id),
        retrievedRecallHit: hit,
        modelAnswer,
        judgeVerdict,
        judgeConfidence,
        judgeRationale,
        durationMs: Date.now() - caseStart,
      });
    }

    let scores = aggregateScores(caseResults);
    const priors = await loadAllPriorScores(runId);
    scores = attachPriorDeltas(scores, priors);

    const result: BenchRunResult = {
      ok: true,
      runId,
      workspaceId,
      gitSha: gitSha(),
      corpusHash,
      scores,
      cases: caseResults,
      models,
      costUsd: 0,
      durationMs: Date.now() - started,
      embeddingModel: process.env.MODEL_EMBEDDING ?? "openai/text-embedding-3-small",
      prNumber: config.prNumber,
    };

    await persistBenchRun(result);

    if (config.postSlack) {
      await postBenchSlackReport(result);
    }

    return result;
  } catch (error) {
    return {
      ok: false,
      runId,
      workspaceId,
      corpusHash,
      scores: [],
      cases: [],
      models,
      costUsd: 0,
      durationMs: Date.now() - started,
      embeddingModel: process.env.MODEL_EMBEDDING ?? "openai/text-embedding-3-small",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await wipeBenchWorkspace(workspaceId);
  }
}

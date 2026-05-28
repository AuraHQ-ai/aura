import { execFileSync } from "node:child_process";
import { loadBenchCases, computeCorpusHash } from "./fixtures.js";
import { ingestBenchCases } from "./ingest.js";
import { evaluateRetrievalCase } from "./eval-retrieval.js";
import { answerFromMemories, judgeAnswer } from "./eval-qa.js";
import { postBenchReport } from "./report.js";
import {
  aggregateScores,
  attachPriorDeltas,
  persistAggregates,
} from "./score.js";
import {
  benchWorkspaceId,
  createBenchWorkspace,
  makeRunId,
  pruneOldBenchWorkspaces,
} from "./workspace.js";
import type { BenchCaseResult, BenchRunConfig, BenchRunResult } from "./types.js";

function currentGitSha(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: new URL("../../..", import.meta.url),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export async function runMemoryBench(config: BenchRunConfig): Promise<BenchRunResult> {
  const started = Date.now();
  const runId = makeRunId();
  const workspaceId = benchWorkspaceId(runId);
  const gitSha = currentGitSha();
  const corpusHash = await computeCorpusHash();

  try {
    const cases = await loadBenchCases({
      dataset: config.dataset,
      subset: config.subset,
      category: config.category,
    });

    if (config.dryRun) {
      return {
        ok: true,
        runId,
        workspaceId,
        corpusHash,
        gitSha,
        durationMs: Date.now() - started,
        aggregates: [],
        cases: [],
      };
    }

    await pruneOldBenchWorkspaces();
    await createBenchWorkspace(workspaceId);

    if (!config.skipIngest) {
      await ingestBenchCases(cases, workspaceId);
    }

    const caseResults: BenchCaseResult[] = [];
    for (const benchCase of cases) {
      const { result, memories } = await evaluateRetrievalCase(benchCase, workspaceId, 15);

      if (config.judge !== false) {
        const answer = await answerFromMemories(benchCase, memories);
        const judged = await judgeAnswer({ benchCase, answer });
        caseResults.push({
          ...result,
          answer,
          verdict: judged.verdict,
          qaCorrect: judged.qaCorrect,
          rationale: judged.rationale,
        });
      } else {
        caseResults.push(result);
      }
    }

    const aggregatesWithoutDeltas = aggregateScores({
      runId,
      cases: caseResults,
      includeQa: config.judge !== false,
    });
    const aggregates = await attachPriorDeltas(aggregatesWithoutDeltas);
    const durationMs = Date.now() - started;

    await persistAggregates({
      aggregates,
      corpusHash,
      gitSha,
      durationMs,
      generationModel: "fast",
      judgeModel: config.judge === false ? undefined : config.judge,
      embeddingModel: "configured",
      prNumber: config.prNumber,
    });

    const result: BenchRunResult = {
      ok: true,
      runId,
      workspaceId,
      corpusHash,
      gitSha,
      durationMs,
      aggregates,
      cases: caseResults,
    };

    if (config.postSlack) {
      await postBenchReport(result);
    }

    return result;
  } catch (error) {
    return {
      ok: false,
      runId,
      workspaceId,
      corpusHash,
      gitSha,
      durationMs: Date.now() - started,
      aggregates: [],
      cases: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

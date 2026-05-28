import { execFileSync } from "node:child_process";
import { loadBenchCases, computeCorpusHash } from "./fixtures.js";
import { benchWorkspaceId, makeRunId } from "./workspace-id.js";
import { resolveBenchModels } from "./models.js";
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
  const corpusHash = await computeCorpusHash({
    dataset: config.dataset,
    corpusFile: config.corpusFile,
  });

  try {
    const cases = await loadBenchCases({
      dataset: config.dataset,
      subset: config.subset,
      category: config.category,
      corpusFile: config.corpusFile,
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

    const { createBenchWorkspace, pruneOldBenchWorkspaces } = await import("./workspace.js");
    const { ingestBenchCases } = await import("./ingest.js");
    const { evaluateRetrievalCase } = await import("./eval-retrieval.js");
    const { answerFromMemories, judgeAnswer } = await import("./eval-qa.js");
    const {
      aggregateScores,
      attachPriorDeltas,
      persistAggregates,
    } = await import("./score.js");

    const models = resolveBenchModels({
      extraction: config.extractionModel,
      answer: config.answerModel,
      judge: typeof config.judge === "string" ? config.judge : undefined,
    });

    await pruneOldBenchWorkspaces();
    await createBenchWorkspace(workspaceId);

    if (!config.skipIngest) {
      await ingestBenchCases(cases, workspaceId, models.extraction);
    }

    const caseResults: BenchCaseResult[] = [];
    for (const benchCase of cases) {
      const { result, memories } = await evaluateRetrievalCase(benchCase, workspaceId, 15);

      if (config.judge !== false) {
        const answer = await answerFromMemories(benchCase, memories, models.answer);
        const judged = await judgeAnswer({
          benchCase,
          answer,
          modelId: models.judge,
        });
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
      generationModel: models.answer,
      judgeModel: config.judge === false
        ? undefined
        : models.judge,
      embeddingModel: "configured",
      prNumber: config.prNumber,
      metadata: {
        subset: config.subset,
        category: config.category ?? null,
        caseCount: caseResults.length,
        extractionModel: models.extraction,
        corpusFile: config.corpusFile ?? null,
      },
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
      const { postBenchReport } = await import("./report.js");
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

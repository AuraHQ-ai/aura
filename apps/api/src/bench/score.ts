import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { benchRuns } from "@aura/db/schema";
import type { BenchRunResult, CategoryScore, PerCaseResult } from "./types.js";
import { BENCH_META_WORKSPACE_ID, ensureBenchMetaWorkspace } from "./workspace.js";

export function aggregateScores(results: PerCaseResult[]): CategoryScore[] {
  const groups = new Map<string, PerCaseResult[]>();
  for (const r of results) {
    const key = `${r.dataset}|${r.category}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const out: CategoryScore[] = [];
  for (const [key, group] of groups) {
    const [dataset, category] = key.split("|");

    const qaScored = group.filter((r) => r.judgeVerdict !== "skipped");
    if (qaScored.length > 0) {
      const nCorrect = qaScored.filter(
        (r) => r.judgeVerdict === "correct" || r.judgeVerdict === "abstain_ok",
      ).length;
      const partialCredit = qaScored.filter((r) => r.judgeVerdict === "partial").length * 0.5;
      out.push({
        dataset,
        category,
        scoreType: "qa_accuracy",
        n: qaScored.length,
        nCorrect,
        score: (nCorrect + partialCredit) / qaScored.length,
      });
    }

    const recallScored = group.filter((r) => r.retrievedRecallHit !== null);
    if (recallScored.length > 0) {
      const nCorrect = recallScored.filter((r) => r.retrievedRecallHit === true).length;
      out.push({
        dataset,
        category,
        scoreType: "retrieval_recall_at_15",
        n: recallScored.length,
        nCorrect,
        score: nCorrect / recallScored.length,
      });
    }

    const abstentions = group.filter((r) => r.abstention);
    if (abstentions.length > 0) {
      const nCorrect = abstentions.filter((r) => r.judgeVerdict === "abstain_ok").length;
      out.push({
        dataset,
        category: "abstention",
        scoreType: "abstention_accuracy",
        n: abstentions.length,
        nCorrect,
        score: nCorrect / abstentions.length,
      });
    }
  }
  return out;
}

export function attachPriorDeltas(
  scores: CategoryScore[],
  priors: Array<{ dataset: string; category: string; scoreType: string; score: number }>,
): CategoryScore[] {
  const priorMap = new Map(
    priors.map((p) => [`${p.dataset}:${p.category}:${p.scoreType}`, p.score]),
  );
  return scores.map((s) => {
    const prior = priorMap.get(`${s.dataset}:${s.category}:${s.scoreType}`);
    return {
      ...s,
      deltaPp: prior !== undefined ? Math.round((s.score - prior) * 100) : undefined,
    };
  });
}

export async function loadAllPriorScores(beforeRunId: string): Promise<
  Array<{ dataset: string; category: string; scoreType: string; score: number }>
> {
  const latest = await db
    .select({
      category: benchRuns.category,
      dataset: benchRuns.dataset,
      scoreType: benchRuns.scoreType,
      score: benchRuns.score,
      runId: benchRuns.runId,
    })
    .from(benchRuns)
    .where(eq(benchRuns.workspaceId, BENCH_META_WORKSPACE_ID))
    .orderBy(desc(benchRuns.createdAt))
    .limit(1000);

  const seen = new Set<string>();
  const out: Array<{ dataset: string; category: string; scoreType: string; score: number }> =
    [];
  for (const row of latest) {
    if (row.runId === beforeRunId) continue;
    const key = `${row.dataset}:${row.category}:${row.scoreType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      category: row.category,
      dataset: row.dataset,
      scoreType: row.scoreType,
      score: row.score,
    });
  }
  return out;
}

export async function persistBenchRun(result: BenchRunResult): Promise<void> {
  await ensureBenchMetaWorkspace();
  const meta = { models: result.models };

  for (const s of result.scores) {
    await db.insert(benchRuns).values({
      workspaceId: BENCH_META_WORKSPACE_ID,
      runId: result.runId,
      dataset: s.dataset,
      category: s.category,
      scoreType: s.scoreType,
      n: s.n,
      nCorrect: s.nCorrect,
      score: s.score,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      generationModel: result.models.answerer,
      judgeModel: result.models.judge,
      embeddingModel: result.embeddingModel,
      corpusHash: result.corpusHash,
      gitSha: result.gitSha,
      prNumber: result.prNumber ?? null,
      metadata: meta,
    });
  }
}

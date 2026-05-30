/**
 * Build the sticky PR comment for a memory bench run.
 *
 * Pure post-processing: reads the run's `--json` output and the base branch's
 * committed `history.jsonl`, diffs the current scores against the newest
 * comparable baseline entry, and writes the comment markdown to `--out`. No DB,
 * no LLM, no network — the workflow runs this in a tiny node step and then posts
 * the file via actions/github-script.
 *
 * Usage (from the workflow):
 *   tsx bench/scripts/pr-comment.ts \
 *     --result=/tmp/bench/result.json \
 *     --base-history=/tmp/bench/base-history.jsonl \
 *     --base-ref=main \
 *     --head-commit=<sha> \
 *     --run-url=<url> \
 *     --out=/tmp/bench/comment.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildHistoryEntry } from "../src/results-log.js";
import {
  diffEntries,
  loadBaselineEntry,
  renderPrComment,
  type BaselineScope,
} from "../src/pr-delta.js";
import type { BenchScore, DatasetId } from "../src/types.js";

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const resultPath = getArg("result");
const outPath = getArg("out");
if (!resultPath || !outPath) {
  console.error("pr-comment: --result=<path> and --out=<path> are required");
  process.exit(1);
}

const baseHistoryPath = getArg("base-history");
const baseRef = getArg("base-ref") ?? "main";
const headCommit = getArg("head-commit") ?? "unknown";
const runUrl = getArg("run-url") ?? null;

interface ResultJson {
  runId: string;
  scores: BenchScore[];
  corpusHash: string;
  caseSetHash: string;
  datasets: string[];
  subset: string;
  costUsd: number | null;
  totalDurationMs: number;
  models: { extraction: string; answerer: string; judge: string } | null;
}

const result = JSON.parse(readFileSync(resolve(resultPath), "utf8")) as ResultJson;

if (!result.scores || result.scores.length === 0) {
  console.error("pr-comment: result JSON has no scores — nothing to diff");
  process.exit(1);
}

// Build a HistoryEntry for the current run so the diff works on the same pivoted
// shape as the committed history (commit/timestamp are unused by the diff).
const current = buildHistoryEntry({
  runId: result.runId,
  scores: result.scores,
  datasets: result.datasets as DatasetId[],
  subset: result.subset,
  corpusHash: result.corpusHash,
  caseSetHash: result.caseSetHash,
  totalDurationMs: result.totalDurationMs,
  costUsd: result.costUsd,
  models: result.models,
});

const scope: BaselineScope = {
  corpusHash: result.corpusHash,
  caseSetHash: result.caseSetHash,
  datasets: result.datasets,
  subset: result.subset,
};

const baseHistoryText =
  baseHistoryPath && existsSync(resolve(baseHistoryPath))
    ? readFileSync(resolve(baseHistoryPath), "utf8")
    : "";

const baseline = loadBaselineEntry(baseHistoryText, scope);
const diff = diffEntries(current, baseline);
const markdown = renderPrComment(diff, {
  baseRef,
  headCommit,
  runId: result.runId,
  runtimeMs: result.totalDurationMs,
  costUsd: result.costUsd,
  scope,
  runUrl,
});

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), markdown);
console.log(markdown);
console.error(
  `\npr-comment: wrote ${outPath} (baseline=${diff.hasBaseline ? diff.baselineCommit : "none"}, regressions=${diff.regressions.length})`,
);

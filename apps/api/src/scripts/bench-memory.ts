/**
 * CLI entry point for the memory benchmark harness.
 *
 *   pnpm bench:memory                                # toy corpus, medium subset
 *   pnpm bench:memory --dataset=lme                  # LongMemEval (cached corpus)
 *   pnpm bench:memory --dataset=both --subset=full   # ~2,500 questions
 *   pnpm bench:memory --dataset=both --subset=fast   # ~40 questions, PR speed
 *   pnpm bench:memory --concurrency=4                # parallel ingest workers
 *   pnpm bench:memory --corpus-file=/path/data.json  # bring-your-own normalized corpus
 *   pnpm bench:memory --dry-run                      # no DB writes, no LLM calls
 *
 * Iterating on a memory change? Ramp the data up in small steps instead of
 * jumping straight to the full set, and focus on the axis you're fixing:
 *   pnpm bench:memory --dataset=lme --category=temporal-reasoning --limit=3
 *   pnpm bench:memory --dataset=lme --category=temporal-reasoning --limit=10 --log
 * --limit=N caps cases per category (overrides --subset). --log appends a
 * fingerprint (commit + scores) to apps/api/bench/RESULTS.md; pair with
 * --note="…" for context.
 *
 * Model overrides accept either a gateway model id or a catalog tier name:
 *   --extraction-model=anthropic/claude-sonnet-4.6   # explicit pin
 *   --extraction-model=main                          # tier (resolves via DB catalog)
 *   --judge-model=escalation                         # default; Opus-class today
 *
 * Defaults: extraction=main, answerer=main, judge=escalation. The exact
 * model id used is persisted on bench_runs so cross-run deltas stay
 * honest when the catalog gets updated.
 *
 * Mirrors the pattern of `backfill-memories.ts`: dotenv at the top, `--prod`
 * to switch to `.env.production`.
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");

const argv = process.argv.slice(2);
const isProd = argv.includes("--prod");
const envFile = isProd ? ".env.production" : ".env.local";
config({ path: resolve(repoRoot, envFile) });
if (isProd) console.log("Using .env.production (--prod)");

const { runBench } = await import("../../bench/src/runner.js");
const { logger } = await import("../lib/logger.js");

function getFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return argv.includes(`--${name}`);
}

const datasetArg = getFlag("dataset") ?? "toy";
const datasets =
  datasetArg === "both"
    ? (["locomo", "longmemeval"] as const)
    : datasetArg === "lme"
      ? (["longmemeval"] as const)
      : datasetArg === "all"
        ? (["toy", "longmemeval", "locomo"] as const)
        : ([datasetArg] as any);

const subsetArg = (getFlag("subset") ?? "medium") as "fast" | "medium" | "full";
const limit = getFlag("limit") ? Number(getFlag("limit")) : undefined;
const category = getFlag("category");
const judgeModel = getFlag("judge-model") ?? getFlag("judge");
const extractionModel = getFlag("extraction-model");
const answererModel = getFlag("answerer-model");
const concurrency = getFlag("concurrency") ? Number(getFlag("concurrency")) : undefined;
const corpusFile = getFlag("corpus-file");
const jsonOut = getFlag("json");
// CI passes --pr-number (or PR_NUMBER env) so the run row is attributable to a
// pull request; nightly/manual runs leave it null.
const prNumberArg = getFlag("pr-number") ?? process.env.PR_NUMBER;
const prNumber =
  prNumberArg && Number.isFinite(Number(prNumberArg))
    ? Number(prNumberArg)
    : undefined;

const cfg = {
  datasets,
  subset: subsetArg,
  limit,
  category,
  skipIngest: hasFlag("skip-ingest"),
  dryRun: hasFlag("dry-run"),
  postSlack: hasFlag("post-slack"),
  extractionModel,
  answererModel,
  judgeModel,
  concurrency,
  corpusFile,
  prNumber,
};

const note = getFlag("note");
const logResults = hasFlag("log");

if (cfg.dryRun) console.log("DRY RUN — no DB writes, no LLM calls");
console.log(
  `Running bench: datasets=${cfg.datasets.join(",")} ${limit ? "limit=" + limit : "subset=" + cfg.subset}${category ? " category=" + category : ""}`,
);

try {
  const output = await runBench(cfg);
  console.log("\n" + output.textSummary);

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(
      {
        runId: output.runId,
        scores: output.scores,
        deltas: Object.fromEntries(output.deltas),
        results: output.results,
        totalDurationMs: output.totalDurationMs,
        corpusHash: output.corpusHash,
      },
      null,
      2,
    ));
    console.log(`\nWrote detailed JSONL to ${jsonOut}`);
  }

  // Append a commit-stamped fingerprint to RESULTS.md when asked. Skipped for
  // dry runs and empty result sets (nothing meaningful to record).
  if (logResults && !cfg.dryRun && output.scores.length > 0) {
    const { appendResultsLog } = await import("../../bench/src/results-log.js");
    const path = appendResultsLog({
      runId: output.runId,
      scores: output.scores,
      datasets: [...cfg.datasets],
      subset: cfg.subset,
      limit: cfg.limit,
      category: cfg.category,
      corpusHash: output.corpusHash,
      totalDurationMs: output.totalDurationMs,
      note,
    });
    console.log(`\nLogged result fingerprint to ${path}`);
  } else if (logResults && (cfg.dryRun || output.scores.length === 0)) {
    console.log("\n--log skipped (dry run or no scores to record).");
  }

  process.exit(0);
} catch (err) {
  logger.error("bench: fatal error", { error: String(err) });
  console.error(err);
  process.exit(1);
}

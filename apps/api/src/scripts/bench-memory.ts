/**
 * CLI entry point for the memory benchmark harness.
 *
 *   pnpm bench:memory                          # toy corpus, full subset
 *   pnpm bench:memory --dataset=lme            # LongMemEval (if vendored)
 *   pnpm bench:memory --dataset=both --subset=fast --post-slack
 *   pnpm bench:memory --dry-run                # no DB writes, no LLM calls
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

const subsetArg = (getFlag("subset") ?? "full") as "fast" | "full";
const category = getFlag("category");
const judgeModel = getFlag("judge");
const jsonOut = getFlag("json");

const cfg = {
  datasets,
  subset: subsetArg,
  category,
  skipIngest: hasFlag("skip-ingest"),
  dryRun: hasFlag("dry-run"),
  postSlack: hasFlag("post-slack"),
  judgeModel,
};

if (cfg.dryRun) console.log("DRY RUN — no DB writes, no LLM calls");
console.log(
  `Running bench: datasets=${cfg.datasets.join(",")} subset=${cfg.subset}${category ? " category=" + category : ""}`,
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

  process.exit(0);
} catch (err) {
  logger.error("bench: fatal error", { error: String(err) });
  console.error(err);
  process.exit(1);
}

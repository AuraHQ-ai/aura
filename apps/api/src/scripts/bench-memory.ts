import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
const dryRun = process.argv.includes("--dry-run");
const skipIngest = process.argv.includes("--skip-ingest");
const postSlack = process.argv.includes("--post-slack");
const jsonOut = process.argv.includes("--json");
const useFastModels = process.argv.includes("--fast-models");
const envFile = isProd ? ".env.production" : ".env.local";
config({ path: resolve(repoRoot, envFile) });

/** Bench quality defaults: Sonnet extraction/answer, Opus judge (override with --fast-models). */
if (!useFastModels) {
  process.env.AURA_BENCH_EXTRACTION ??= "main";
  process.env.AURA_BENCH_ANSWER ??= "main";
  process.env.AURA_BENCH_JUDGE ??= "escalation";
}

if (isProd) console.log("Using .env.production (--prod)");
if (dryRun) console.log("DRY RUN — no DB writes");
if (!useFastModels) {
  console.log(
    "Models: extraction=main answer=main judge=escalation (--fast-models for Haiku-tier)",
  );
}

function argValue(prefix: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${prefix}=`));
  return hit?.split("=")[1];
}

import type { BenchDataset, BenchSubset } from "../bench/types.js";

const { runMemoryBench } = await import("../bench/runner.js");

const dataset = (argValue("--dataset") ?? "lme") as BenchDataset;
const subset = (argValue("--subset") ?? "full") as BenchSubset;
const category = argValue("--category");
const judge = process.argv.includes("--judge") || !process.argv.includes("--no-judge");
const concurrency = Number(argValue("--concurrency") ?? "2");
const prNumber = argValue("--pr-number") ? Number(argValue("--pr-number")) : undefined;

const result = await runMemoryBench({
  runId: argValue("--run-id") ?? "",
  workspaceId: "",
  dataset,
  subset,
  categoryFilter: category,
  skipIngest,
  dryRun,
  judge,
  postSlack,
  prNumber,
  concurrency: Number.isFinite(concurrency) ? concurrency : 2,
});

if (jsonOut) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("\nMemory benchmark results\n");
  for (const s of result.scores) {
    const pct = Math.round(s.score * 100);
    console.log(
      `  ${s.dataset} / ${s.category} / ${s.scoreType}: ${pct}% (${s.nCorrect}/${s.n})`,
    );
  }
  console.log(
    `\nRun ${result.runId} in ${Math.round(result.durationMs / 1000)}s · extraction=${result.extractionModel} judge=${result.judgeModel ?? "—"}`,
  );
}

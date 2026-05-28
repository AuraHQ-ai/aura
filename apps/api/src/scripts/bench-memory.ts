import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMemoryBench } from "../bench/runner.js";
import type { BenchDataset, BenchSubset } from "../bench/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
const dryRun = process.argv.includes("--dry-run");
const skipIngest = process.argv.includes("--skip-ingest");
const postSlack = process.argv.includes("--post-slack");
const jsonOut = process.argv.includes("--json");
const envFile = isProd ? ".env.production" : ".env.local";
config({ path: resolve(repoRoot, envFile) });

if (isProd) console.log("Using .env.production (--prod)");
if (dryRun) console.log("DRY RUN — no DB writes");

function argValue(prefix: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${prefix}=`));
  return hit?.split("=")[1];
}

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
  console.log(`\nRun ${result.runId} in ${Math.round(result.durationMs / 1000)}s`);
}

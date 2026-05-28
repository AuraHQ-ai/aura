import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchRunConfig, BenchDataset, BenchSubset } from "../../bench/src/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
const envFile = isProd ? ".env.production" : ".env.local";
loadDotenv({ path: resolve(repoRoot, envFile), quiet: true });

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseConfig(): BenchRunConfig {
  const dataset = (argValue("dataset") ?? "toy") as BenchDataset;
  const subset = (argValue("subset") ?? "fast") as BenchSubset;
  const judgeArg = argValue("judge");
  const prNumber = argValue("pr-number");
  const concurrency = argValue("concurrency");

  if (!["toy", "lme", "longmemeval", "locomo", "both"].includes(dataset)) {
    throw new Error("--dataset must be one of toy, lme, longmemeval, locomo, both");
  }
  if (!["fast", "medium", "full"].includes(subset)) {
    throw new Error("--subset must be one of fast, medium, full");
  }

  return {
    dataset,
    subset,
    category: argValue("category"),
    skipIngest: hasFlag("skip-ingest"),
    dryRun: hasFlag("dry-run"),
    json: hasFlag("json"),
    postSlack: hasFlag("post-slack"),
    answerModel: argValue("answer-model") ?? argValue("answerer-model") ?? process.env.MEMORY_BENCH_ANSWER_MODEL ?? process.env.AURA_BENCH_ANSWERER,
    extractionModel: argValue("extraction-model") ?? process.env.MEMORY_BENCH_EXTRACTION_MODEL ?? process.env.AURA_BENCH_EXTRACTION,
    judge: judgeArg === "false" || judgeArg === "off"
      ? false
      : judgeArg ?? process.env.MEMORY_BENCH_JUDGE_MODEL ?? process.env.AURA_BENCH_JUDGE,
    corpusFile: argValue("corpus-file") ?? process.env.MEMORY_BENCH_CORPUS_FILE,
    concurrency: concurrency ? Number(concurrency) : undefined,
    prNumber: prNumber ? Number(prNumber) : undefined,
  };
}

const { runMemoryBench } = await import("../../bench/src/runner.js");
const { formatBenchReport } = await import("../../bench/src/report.js");

try {
  const result = await runMemoryBench(parseConfig());
  if (result.ok) {
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatBenchReport(result));
    }
    process.exit(0);
  }

  console.error(JSON.stringify({ ok: false, error: result.error, runId: result.runId }));
  process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
}

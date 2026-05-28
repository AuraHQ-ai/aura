import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchDataset, BenchRunConfig, BenchSubset } from "../bench/types.js";
import { formatBenchReport } from "../bench/report.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
loadDotenv({ path: resolve(repoRoot, process.argv.includes("--prod") ? ".env.production" : ".env.local") });

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseConfig(): BenchRunConfig {
  const judgeArg = argValue("judge");
  return {
    dataset: (argValue("dataset") ?? "lme") as BenchDataset,
    subset: (argValue("subset") ?? "full") as BenchSubset,
    categoryFilter: argValue("category"),
    corpusFile: argValue("corpus-file"),
    skipIngest: hasFlag("skip-ingest"),
    dryRun: hasFlag("dry-run"),
    postSlack: hasFlag("post-slack"),
    judge:
      judgeArg === "false" || judgeArg === "off"
        ? false
        : judgeArg ?? true,
    prNumber: argValue("pr-number") ? Number(argValue("pr-number")) : undefined,
    concurrency: Number(argValue("concurrency") ?? "2") || 2,
    models: {
      extraction: argValue("extraction-model") ?? process.env.BENCH_EXTRACTION_MODEL,
      answerer: argValue("answer-model") ?? process.env.BENCH_ANSWERER_MODEL,
      judge: typeof judgeArg === "string" && judgeArg.includes("/") ? judgeArg : process.env.BENCH_JUDGE_MODEL,
    },
  };
}

const config = parseConfig();
const { runMemoryBench } = await import("../bench/runner.js");

try {
  const result = await runMemoryBench(config);
  if (hasFlag("json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatBenchReport(result));
  }
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

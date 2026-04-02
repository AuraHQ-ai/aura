import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { createProgress, type ProgressTracker } from "../lib/progress.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
const envFile = isProd ? ".env.production" : ".env.local";
config({ path: resolve(repoRoot, envFile) });
if (isProd) console.log("Using .env.production (--prod)");

function parseIntFlag(name: string): number | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return undefined;
  const val = parseInt(arg.slice(prefix.length), 10);
  return Number.isNaN(val) ? undefined : val;
}

const forceAll = process.argv.includes("--force-all");
const concurrency = parseIntFlag("concurrency") ?? 5;

const { regenerateStaleSummaries } = await import(
  "../memory/entity-summaries.js"
);

async function main() {
  console.log("=== Entity Summary Backfill ===\n");
  console.log(`  mode:        ${forceAll ? "force-all (regenerate everything)" : "incremental (stale/missing only)"}`);
  console.log(`  concurrency: ${concurrency}`);
  console.log();

  let progress: ProgressTracker | null = null;

  const result = await regenerateStaleSummaries({
    forceAll,
    concurrency,
    onProgress: (_completed, total) => {
      if (!progress) progress = createProgress(total, { label: "entities", logEvery: 5 });
      progress.tick();
    },
  });

  console.log(`\n=== Summary ===`);
  (progress as ProgressTracker | null)?.done();
  console.log(`Candidates: ${result.totalCandidates}`);
  console.log(`Updated:    ${result.updated}`);
  console.log(`Skipped:    ${result.skipped}`);

  if (!forceAll && result.totalCandidates === 0) {
    console.log("\nAll entity summaries are up to date. Use --force-all to regenerate everything.");
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

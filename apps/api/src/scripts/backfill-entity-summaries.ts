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

const { regenerateStaleSummaries } = await import(
  "../memory/entity-summaries.js"
);

async function main() {
  console.log("=== Entity Summary Backfill ===\n");

  let progress: ProgressTracker | null = null;

  const result = await regenerateStaleSummaries({
    forceAll: true,
    onProgress: (_completed, total) => {
      if (!progress) progress = createProgress(total, { label: "entities", logEvery: 5 });
      progress.tick();
    },
  });

  console.log(`\n=== Summary ===`);
  (progress as ProgressTracker | null)?.done();
  console.log(`Updated: ${result.updated}`);
  console.log(`Skipped: ${result.skipped}`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

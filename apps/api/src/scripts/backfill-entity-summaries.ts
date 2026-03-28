import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

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
  const start = Date.now();

  const result = await regenerateStaleSummaries({ forceAll: true });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n=== Summary ===`);
  console.log(`Elapsed: ${elapsed}s`);
  console.log(`Updated: ${result.updated}`);
  console.log(`Skipped: ${result.skipped}`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

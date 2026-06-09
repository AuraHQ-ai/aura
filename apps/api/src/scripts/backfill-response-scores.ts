import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
config({ path: resolve(repoRoot, isProd ? ".env.production" : ".env.local") });

function readNumberFlag(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return fallback;
  const value = Number(arg.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const limit = readNumberFlag("limit", 100);
const concurrency = readNumberFlag("concurrency", 2);

const { scoreUnscoredResponses } = await import("../eval/response-scorer.js");

if (isProd) console.log("Using .env.production (--prod)");
console.log("=== Response Eval Score Backfill ===");
console.log(`Limit: ${limit}`);
console.log(`Concurrency: ${concurrency}`);

const result = await scoreUnscoredResponses({ limit, concurrency });

console.log("\n=== Summary ===");
console.log(`Candidate parts: ${result.candidates}`);
console.log(`Windows judged: ${result.windows}`);
console.log(`Scores returned: ${result.scored}`);
console.log(`Rows inserted: ${result.inserted}`);
console.log(`Window errors: ${result.errors}`);

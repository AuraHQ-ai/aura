/**
 * Manual backfill driver for the eval response funnel.
 *
 * Runs the same forward walk as the overnight cron (oldest unscored thread
 * groups first), but loops batch after batch until the backlog is exhausted —
 * useful for the initial walk from corpus start (March 12) without waiting
 * for nightly cron invocations. Fully idempotent: safe to interrupt and
 * re-run; already-scored responses are never re-judged.
 *
 * Usage:
 *   pnpm backfill:response-scores                       # .env.local, loop to done
 *   pnpm backfill:response-scores --prod                # production DB
 *   pnpm backfill:response-scores --limit=10            # groups per batch
 *   pnpm backfill:response-scores --max-batches=3       # stop after N batches
 */
import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
config({ path: resolve(repoRoot, isProd ? ".env.production" : ".env.local") });
if (isProd) console.log("Using .env.production (--prod)");

function readNumberFlag(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return fallback;
  const value = Number(arg.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const groupsPerBatch = readNumberFlag("limit", 25);
const maxBatches = readNumberFlag("max-batches", Number.MAX_SAFE_INTEGER);

const { findUnscoredGroups, scoreGroup } = await import(
  "../cron/eval-responses.js"
);

console.log("=== Eval Response Score Backfill ===");
console.log(`Groups per batch: ${groupsPerBatch}`);

let batch = 0;
let totalGroups = 0;
let totalWindows = 0;
let totalScored = 0;
let totalOmitted = 0;
let totalErrors = 0;

while (batch < maxBatches) {
  batch++;
  const groups = await findUnscoredGroups(groupsPerBatch);
  if (groups.length === 0) {
    console.log("\nBacklog exhausted — every settled response is scored.");
    break;
  }

  console.log(`\n--- Batch ${batch}: ${groups.length} thread group(s) ---`);
  for (const group of groups) {
    const label = group.threadTs
      ? `${group.channelId ?? "?"} :: ${group.threadTs}`
      : `trace ${group.soleTraceId}`;
    try {
      // Scripts have no serverless wall clock — give each group a generous budget.
      const result = await scoreGroup(group, Date.now() + 30 * 60_000);
      totalGroups++;
      totalWindows += result.windowsJudged;
      totalScored += result.responsesScored;
      totalOmitted += result.omitted;
      console.log(
        `  ${label}: ${result.responsesScored} scored across ${result.windowsJudged} window(s)` +
          (result.omitted > 0 ? ` (${result.omitted} omitted)` : ""),
      );
    } catch (error) {
      totalErrors++;
      console.error(
        `  ${label}: FAILED (will retry on a future run) — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

console.log("\n=== Summary ===");
console.log(`Batches: ${batch}`);
console.log(`Thread groups processed: ${totalGroups}`);
console.log(`Windows judged: ${totalWindows}`);
console.log(`Responses scored: ${totalScored}`);
console.log(`Judge omissions (stored non-scorable): ${totalOmitted}`);
console.log(`Group errors: ${totalErrors}`);

process.exit(totalErrors > 0 && totalScored === 0 ? 1 : 0);

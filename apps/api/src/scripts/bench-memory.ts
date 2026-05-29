/**
 * CLI entry point for the memory benchmark harness.
 *
 *   pnpm bench:memory                                # toy corpus, medium subset
 *   pnpm bench:memory --dataset=lme                  # LongMemEval (cached corpus)
 *   pnpm bench:memory --dataset=both --subset=full   # entire loaded corpus
 *   pnpm bench:memory --dataset=both --subset=fast   # ~10m server budget
 *   pnpm bench:memory --concurrency=4                # parallel ingest workers
 *   pnpm bench:memory --corpus-file=/path/data.json  # bring-your-own normalized corpus
 *   pnpm bench:memory --dry-run                      # no DB writes, no LLM calls
 *
 * Staged local dev (data persists in a stable `bench-local-*` workspace so you
 * can re-run just the stage you're iterating on). Stages run in order:
 *   messages → extract → score
 *
 *   pnpm bench:memory --reset                        # wipe + run all stages fresh
 *   pnpm bench:memory --from=extract                 # reuse messages, re-extract + score
 *   pnpm bench:memory --from=score                   # reuse memories, only re-run retrieval+QA
 *   pnpm bench:memory --from=messages --to=extract   # load + extract, stop before scoring
 *   pnpm bench:memory --from=messages --to=messages --skip-message-embeddings # seed raw corpus rows
 *   pnpm bench:memory --embed-concurrency=8          # parallel embedding/message workers
 *   pnpm bench:memory --bench-id=my-exp              # explicit persistent workspace key
 * Any of --from/--to/--reset/--persist/--bench-id switches to the persistent
 * local workspace (it is NOT wiped at the end). Use --reset to start clean.
 *
 * Extraction cadence (--replay, default "session"):
 *   --replay=session    one extraction per session (cheap, default)
 *   --replay=exchange   one extraction per assistant turn over a sliding
 *   --per-exchange      30-message window — mirrors prod's per-reply cadence.
 * Per-exchange runs use a separate `bench-local-*-px` workspace, so you can
 * A/B it against the session cadence without clobbering. Bench both, e.g.:
 *   pnpm bench:memory --dataset=both --subset=fast --reset                # session
 *   pnpm bench:memory --dataset=both --subset=fast --reset --per-exchange # exchange
 *
 * Iterating on a memory change? Ramp the data up in small steps instead of
 * jumping straight to the full set, and focus on the axis you're fixing:
 *   pnpm bench:memory --dataset=lme --category=temporal-reasoning --limit=3
 *   pnpm bench:memory --dataset=lme --category=temporal-reasoning --limit=10 --log
 * --limit=N caps cases per category (overrides --subset). --log appends a
 * fingerprint (commit + scores) to apps/api/bench/RESULTS.md; pair with
 * --note="…" for context.
 *
 * Model overrides accept either a gateway model id or a catalog tier name:
 *   --extraction-model=anthropic/claude-sonnet-4.6   # explicit pin
 *   --extraction-model=main                          # tier (resolves via DB catalog)
 *   --judge-model=escalation                         # default; Opus-class today
 *
 * Runtime tiers are budgets for fast/medium; full means the entire loaded
 * corpus and can take hours. Defaults: extraction=fast, answerer=main,
 * judge=escalation. The exact
 * model id used is persisted on bench_runs so cross-run deltas stay
 * honest when the catalog gets updated.
 *
 * Mirrors the pattern of `backfill-memories.ts`: dotenv at the top, `--prod`
 * to switch to `.env.production`. If BENCH_DATABASE_URL is set, it overrides
 * DATABASE_URL for this process before any DB modules are imported.
 */

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");

const argv = process.argv.slice(2);
const isProd = argv.includes("--prod");
const envFile = isProd ? ".env.production" : ".env.local";
config({ path: resolve(repoRoot, envFile) });
if (isProd) console.log("Using .env.production (--prod)");
if (process.env.BENCH_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.BENCH_DATABASE_URL;
  console.log("Using BENCH_DATABASE_URL for memory bench database");
}

const { runBench } = await import("../../bench/src/runner.js");
const { logger } = await import("../lib/logger.js");
type BenchRunConfig = import("../../bench/src/types.js").BenchRunConfig;

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

const subsetArg = (getFlag("subset") ?? "medium") as "fast" | "medium" | "full";
const limit = getFlag("limit") ? Number(getFlag("limit")) : undefined;
// --cases=N caps the TOTAL number of cases (distinct from --limit, per-category).
const cases = getFlag("cases") ? Number(getFlag("cases")) : undefined;
const category = getFlag("category");
const skipMessageEmbeddings = hasFlag("skip-message-embeddings");
const judgeModel = getFlag("judge-model") ?? getFlag("judge");
const extractionModel = getFlag("extraction-model");
const answererModel = getFlag("answerer-model");
const concurrency = getFlag("concurrency") ? Number(getFlag("concurrency")) : undefined;
const embedConcurrency = getFlag("embed-concurrency")
  ? Number(getFlag("embed-concurrency"))
  : undefined;
const corpusFile = getFlag("corpus-file");
const jsonOut = getFlag("json");

const VALID_STAGES = ["messages", "extract", "score"] as const;
type Stage = (typeof VALID_STAGES)[number];
function parseStage(name: string): Stage | undefined {
  const v = getFlag(name);
  if (!v) return undefined;
  if (!VALID_STAGES.includes(v as Stage)) {
    console.error(
      `Invalid --${name}=${v}. Expected one of: ${VALID_STAGES.join(", ")}`,
    );
    process.exit(1);
  }
  return v as Stage;
}
const fromStage = parseStage("from");
const toStage = parseStage("to");
const benchId = getFlag("bench-id");
const reset = hasFlag("reset");
const persist = hasFlag("persist");
// Extraction cadence. --per-exchange is shorthand for --replay=exchange.
const replayArg = getFlag("replay") ?? (hasFlag("per-exchange") ? "exchange" : undefined);
if (replayArg && replayArg !== "session" && replayArg !== "exchange") {
  console.error(`Invalid --replay=${replayArg}. Expected: session | exchange`);
  process.exit(1);
}
const replay = replayArg as "session" | "exchange" | undefined;
// --no-progress forces the periodic-log fallback even in a TTY.
const progress = hasFlag("no-progress") ? false : undefined;
// --resume[=runId] continues a prior run: skip already-scored cases. Bare flag
// (or empty value) resumes the latest run via the runs/latest pointer.
const resumeVal = getFlag("resume");
const resume =
  resumeVal !== undefined ? resumeVal : hasFlag("resume") ? "" : undefined;
// CI passes --pr-number (or PR_NUMBER env) so the run row is attributable to a
// pull request; nightly/manual runs leave it null.
const prNumberArg = getFlag("pr-number") ?? process.env.PR_NUMBER;
const prNumber =
  prNumberArg && Number.isFinite(Number(prNumberArg))
    ? Number(prNumberArg)
    : undefined;

// Cooperative cancellation: first signal asks the runner to drain in-flight
// cases and persist partial results; a second signal force-quits. GitHub
// Actions sends SIGTERM on timeout/cancel, so handle it like Ctrl-C.
const cancelSignal = { cancelled: false };
let signalCount = 0;
function requestCancel(signal: NodeJS.Signals): void {
  signalCount += 1;
  if (signalCount === 1) {
    cancelSignal.cancelled = true;
    console.error(
      `\n${signal} — finishing in-flight cases and saving partial results… (send the signal again to force quit)`,
    );
  } else {
    console.error("\nForce quit.");
    process.exit(130);
  }
}
process.on("SIGINT", requestCancel);
process.on("SIGTERM", requestCancel);
process.on("SIGHUP", requestCancel);

// Launch the guided wizard on --interactive/-i, or when this is an interactive
// terminal and the user passed no meaningful flags. CI always passes flags.
const meaningfulArgs = argv.filter(
  (a) => a !== "--prod" && a !== "-i" && a !== "--interactive",
);
const wantWizard =
  hasFlag("interactive") ||
  argv.includes("-i") ||
  (Boolean(process.stdout.isTTY) && meaningfulArgs.length === 0);

let wizardTip: string | null = null;
let cfg: Partial<BenchRunConfig>;

if (wantWizard) {
  const { runWizard } = await import("../../bench/src/wizard.js");
  const w = await runWizard();
  wizardTip = w.command;
  cfg = { ...w.cfg, resume, cancelSignal };
} else {
  cfg = {
    datasets,
    subset: subsetArg,
    limit,
    cases,
    category,
    skipMessageEmbeddings,
    skipIngest: hasFlag("skip-ingest"),
    dryRun: hasFlag("dry-run"),
    postSlack: hasFlag("post-slack"),
    extractionModel,
    answererModel,
    judgeModel,
    concurrency,
    embedConcurrency,
    corpusFile,
    prNumber,
    fromStage,
    toStage,
    benchId,
    reset,
    persist,
    progress,
    replay,
    resume,
    cancelSignal,
  };
}

const note = getFlag("note");
const logResults = hasFlag("log");

if (cfg.dryRun) console.log("DRY RUN — no DB writes, no LLM calls");
if (!wantWizard) {
  const staged = Boolean(fromStage || toStage || reset || persist || benchId);
  console.log(
    `Running bench: datasets=${(cfg.datasets as string[]).join(",")} ${limit ? "limit=" + limit : "subset=" + cfg.subset}${cases ? " cases=" + cases : ""}${category ? " category=" + category : ""}` +
      `  [replay=${replay ?? "session"}]` +
      (resume != null ? `  [resume${resume ? "=" + resume : "=latest"}]` : "") +
      (staged
        ? `  [stages ${fromStage ?? "messages"}→${toStage ?? "score"}${reset ? ", reset" : ""}${skipMessageEmbeddings ? ", raw messages" : ""}]`
        : ""),
  );
}

try {
  const output = await runBench(cfg);
  console.log("\n" + output.textSummary);

  if (jsonOut) {
    // Create the parent dir so a missing path doesn't fail the run after all
    // the expensive work is already done.
    mkdirSync(dirname(resolve(jsonOut)), { recursive: true });
    writeFileSync(jsonOut, JSON.stringify(
      {
        runId: output.runId,
        scores: output.scores,
        deltas: Object.fromEntries(output.deltas),
        results: output.results,
        totalDurationMs: output.totalDurationMs,
        corpusHash: output.corpusHash,
        caseSetHash: output.caseSetHash,
      },
      null,
      2,
    ));
    console.log(`\nWrote detailed JSONL to ${jsonOut}`);
  }

  // Record a structured entry in history.jsonl and regenerate the markdown
  // views (bench README + root README snapshot). Skipped for dry runs and
  // empty result sets (nothing meaningful to record).
  if (logResults && !cfg.dryRun && output.scores.length > 0) {
    const { recordRun } = await import("../../bench/src/results-log.js");
    const { historyFile, benchReadme, mainReadme } = recordRun({
      runId: output.runId,
      scores: output.scores,
      datasets: [...(cfg.datasets ?? [])],
      subset: cfg.subset ?? "medium",
      limit: cfg.limit,
      category: cfg.category,
      corpusHash: output.corpusHash,
      caseSetHash: output.caseSetHash,
      totalDurationMs: output.totalDurationMs,
      costUsd: output.costUsd,
      models: output.models,
      note,
    });
    console.log(`\nLogged run to ${historyFile}`);
    console.log(`Regenerated ${benchReadme}`);
    if (mainReadme) console.log(`Regenerated snapshot in ${mainReadme}`);
  } else if (logResults && (cfg.dryRun || output.scores.length === 0)) {
    console.log("\n--log skipped (dry run or no scores to record).");
  }

  if (wizardTip) {
    console.log(`\nTip: next time, skip the wizard with:\n   ${wizardTip}`);
  }

  process.exit(0);
} catch (err) {
  logger.error("bench: fatal error", { error: String(err) });
  console.error(err);
  process.exit(1);
}

/**
 * Structured, committed history for the memory bench + the markdown views
 * derived from it.
 *
 * The source of truth is `apps/api/bench/history.jsonl` — one JSON object per
 * logged run (`pnpm bench:memory … --log`). From that we regenerate two human
 * views so the committed docs always reflect the current codebase:
 *
 *   - `apps/api/bench/README.md`  detailed: current scores + evolution table
 *   - root `README.md`            a compact snapshot block between markers
 *
 * Nothing here should be hand-edited. Re-run with `--log`, or regenerate the
 * markdown from the existing history with `pnpm bench:report`.
 */

import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchScore, DatasetId } from "./types.js";

// bench/src/ — everything else is resolved relative to this.
const HERE = fileURLToPath(new URL(".", import.meta.url));

export const MAIN_SNAPSHOT_START = "<!-- BENCH_SNAPSHOT:START -->";
export const MAIN_SNAPSHOT_END = "<!-- BENCH_SNAPSHOT:END -->";

const GENERATED_NOTICE =
  "<!-- Generated from history.jsonl by `pnpm bench:memory … --log` / `pnpm bench:report`. Do not edit by hand. -->";

/** One (dataset, category) row: QA accuracy + retrieval recall@15. */
export interface HistoryScore {
  dataset: string;
  category: string;
  qa: number | null;
  recall: number | null;
  n: number;
}

/** One logged bench run. Append-only; newest is the last line of the file. */
export interface HistoryEntry {
  runId: string;
  timestamp: string;
  commit: string;
  dirty: boolean;
  datasets: string[];
  subset: string;
  limit: number | null;
  category: string | null;
  corpusHash: string;
  caseSetHash: string | null;
  runtimeMs: number;
  costUsd: number | null;
  models: { extraction: string; answerer: string; judge: string } | null;
  scores: HistoryScore[];
  overall: { qa: number | null; recall: number | null; n: number };
  note?: string;
}

export interface RecordRunInput {
  runId: string;
  scores: BenchScore[];
  datasets: DatasetId[];
  subset: string;
  limit?: number;
  category?: string;
  corpusHash: string;
  caseSetHash?: string;
  totalDurationMs: number;
  costUsd?: number | null;
  models?: { extraction: string; answerer: string; judge: string } | null;
  note?: string;
}

export function historyPath(): string {
  return resolve(HERE, "../history.jsonl");
}

export function benchReadmePath(): string {
  return resolve(HERE, "../README.md");
}

export function mainReadmePath(): string {
  return resolve(HERE, "../../../../README.md");
}

function resolveCommit(): { commit: string; dirty: boolean } {
  try {
    const commit = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const dirty =
      execSync("git status --porcelain", {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim().length > 0;
    return { commit: commit || "unknown", dirty };
  } catch {
    return { commit: "unknown", dirty: false };
  }
}

function fmtPct(score: number | null | undefined): string {
  return score === null || score === undefined ? "—" : `${Math.round(score * 100)}%`;
}

function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  return `${Math.floor(totalSec / 60)}m${String(totalSec % 60).padStart(2, "0")}s`;
}

function fmtCost(usd: number | null | undefined): string {
  return usd === null || usd === undefined ? "—" : `$${usd.toFixed(2)}`;
}

function fmtScope(e: {
  datasets: string[];
  subset: string;
  limit: number | null;
}): string {
  const sizing = e.limit && e.limit > 0 ? `limit=${e.limit}` : e.subset;
  return `${e.datasets.join("+")}/${sizing}`;
}

/** Pivot the raw aggregated scores into one (dataset, category) row each. */
function pivotScores(scores: BenchScore[]): HistoryScore[] {
  const rows = new Map<string, HistoryScore>();
  for (const s of scores) {
    const key = `${s.dataset}|${s.category}`;
    const row =
      rows.get(key) ?? { dataset: s.dataset, category: s.category, qa: null, recall: null, n: 0 };
    if (s.scoreType === "qa_accuracy") {
      row.qa = s.score;
      row.n = Math.max(row.n, s.n);
    } else if (s.scoreType === "retrieval_recall_at_15") {
      row.recall = s.score;
      row.n = Math.max(row.n, s.n);
    }
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) => a.dataset.localeCompare(b.dataset) || a.category.localeCompare(b.category),
  );
}

/** Weighted overall QA + recall across all qa/recall lanes in the run. */
function computeOverall(scores: BenchScore[]): {
  qa: number | null;
  recall: number | null;
  n: number;
} {
  let qaCorrect = 0;
  let qaN = 0;
  let recallSum = 0;
  let recallN = 0;
  for (const s of scores) {
    if (s.scoreType === "qa_accuracy") {
      qaCorrect += s.score * s.n;
      qaN += s.n;
    } else if (s.scoreType === "retrieval_recall_at_15") {
      recallSum += s.score * s.n;
      recallN += s.n;
    }
  }
  return {
    qa: qaN > 0 ? qaCorrect / qaN : null,
    recall: recallN > 0 ? recallSum / recallN : null,
    n: qaN,
  };
}

export function buildHistoryEntry(input: RecordRunInput): HistoryEntry {
  const { commit, dirty } = resolveCommit();
  return {
    runId: input.runId,
    timestamp: new Date().toISOString(),
    commit,
    dirty,
    datasets: [...input.datasets],
    subset: input.subset,
    limit: input.limit && input.limit > 0 ? input.limit : null,
    category: input.category ?? null,
    corpusHash: input.corpusHash,
    caseSetHash: input.caseSetHash ?? null,
    runtimeMs: input.totalDurationMs,
    costUsd: input.costUsd ?? null,
    models: input.models ?? null,
    scores: pivotScores(input.scores),
    overall: computeOverall(input.scores),
    ...(input.note ? { note: input.note } : {}),
  };
}

export function appendHistory(entry: HistoryEntry, file: string = historyPath()): string {
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return file;
}

export function readHistory(file: string = historyPath()): HistoryEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as HistoryEntry);
}

function scoresTable(scores: HistoryScore[]): string {
  const lines = ["| dataset | category | QA acc | recall@15 | n |", "|---|---|---:|---:|---:|"];
  for (const r of scores) {
    lines.push(`| ${r.dataset} | ${r.category} | ${fmtPct(r.qa)} | ${fmtPct(r.recall)} | ${r.n} |`);
  }
  return lines.join("\n");
}

/** Render the detailed bench README from the full history. Returns the path. */
export function renderBenchReadme(
  history: HistoryEntry[],
  file: string = benchReadmePath(),
): string {
  const lines: string[] = [];
  lines.push("# Memory bench results");
  lines.push("");
  lines.push(GENERATED_NOTICE);
  lines.push("");
  lines.push(
    "The memory bench replays vendored LoCoMo + LongMemEval corpora through Aura's real",
  );
  lines.push(
    "`extract → retrieve → answer` pipeline and scores each category on deterministic",
  );
  lines.push(
    "retrieval recall@15 and LLM-judged QA accuracy. Runs are logged locally with",
  );
  lines.push(
    "`pnpm bench:memory … --log`, which appends to `history.jsonl` and regenerates this",
  );
  lines.push("file plus the snapshot in the root `README.md`. See the `aura-memory-bench` skill.");
  lines.push("");

  if (history.length === 0) {
    lines.push("_No runs logged yet. Run `pnpm bench:memory --dataset=toy --log`._");
    lines.push("");
    writeFileSync(file, lines.join("\n"));
    return file;
  }

  const latest = history[history.length - 1]!;

  lines.push("## Current");
  lines.push("");
  lines.push(
    `Latest logged run: \`${latest.commit}${latest.dirty ? "-dirty" : ""}\` · ${latest.timestamp.replace("T", " ").slice(0, 16)} UTC`,
  );
  lines.push("");
  lines.push(
    `- scope: \`${fmtScope(latest)}\` · corpus \`${latest.corpusHash.slice(0, 12)}\`${latest.caseSetHash ? ` · cases \`${latest.caseSetHash}\`` : ""} · runtime ${fmtDuration(latest.runtimeMs)} · cost ${fmtCost(latest.costUsd)}`,
  );
  if (latest.models) {
    lines.push(
      `- models: extraction \`${latest.models.extraction}\` · answerer \`${latest.models.answerer}\` · judge \`${latest.models.judge}\``,
    );
  }
  lines.push(
    `- overall: QA ${fmtPct(latest.overall.qa)} · recall@15 ${fmtPct(latest.overall.recall)} (n=${latest.overall.n})`,
  );
  if (latest.category) lines.push(`- category filter: \`${latest.category}\``);
  if (latest.note) lines.push(`- note: ${latest.note}`);
  lines.push("");
  lines.push(scoresTable(latest.scores));
  lines.push("");

  lines.push("## Evolution");
  lines.push("");
  lines.push("Overall QA accuracy and recall@15 across logged runs (newest first).");
  lines.push("");
  lines.push("| date | commit | scope | QA | recall@15 | n | cost | runtime |");
  lines.push("|---|---|---|---:|---:|---:|---:|---:|");
  for (const e of [...history].reverse()) {
    lines.push(
      `| ${e.timestamp.slice(0, 10)} | \`${e.commit}${e.dirty ? "-dirty" : ""}\` | ${fmtScope(e)} | ${fmtPct(e.overall.qa)} | ${fmtPct(e.overall.recall)} | ${e.overall.n} | ${fmtCost(e.costUsd)} | ${fmtDuration(e.runtimeMs)} |`,
    );
  }
  lines.push("");

  writeFileSync(file, lines.join("\n"));
  return file;
}

/**
 * Replace the snapshot block in the root README with the latest run's compact
 * table. No-op (returns null) when the markers are missing — we never rewrite
 * the rest of the README.
 */
export function renderMainSnapshot(
  latest: HistoryEntry | undefined,
  file: string = mainReadmePath(),
): string | null {
  if (!latest || !existsSync(file)) return null;
  const content = readFileSync(file, "utf8");
  const startIdx = content.indexOf(MAIN_SNAPSHOT_START);
  const endIdx = content.indexOf(MAIN_SNAPSHOT_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;

  const block = [
    MAIN_SNAPSHOT_START,
    `<!-- Generated from apps/api/bench/history.jsonl — do not edit by hand. -->`,
    "",
    `Current codebase (as of \`${latest.commit}${latest.dirty ? "-dirty" : ""}\`, scope \`${fmtScope(latest)}\`): **QA ${fmtPct(latest.overall.qa)}** · **recall@15 ${fmtPct(latest.overall.recall)}** across ${latest.overall.n} questions. Full breakdown + history in [apps/api/bench/README.md](apps/api/bench/README.md).`,
    "",
    scoresTable(latest.scores),
    "",
    MAIN_SNAPSHOT_END,
  ].join("\n");

  const updated =
    content.slice(0, startIdx) + block + content.slice(endIdx + MAIN_SNAPSHOT_END.length);
  writeFileSync(file, updated);
  return file;
}

/** Regenerate both markdown views from the on-disk history. */
export function renderReports(history: HistoryEntry[] = readHistory()): {
  benchReadme: string;
  mainReadme: string | null;
} {
  const benchReadme = renderBenchReadme(history);
  const mainReadme = renderMainSnapshot(history[history.length - 1]);
  return { benchReadme, mainReadme };
}

/**
 * Append one run to the history and regenerate both markdown views. This is the
 * single entry point the CLI calls on `--log`.
 */
export function recordRun(input: RecordRunInput): {
  historyFile: string;
  benchReadme: string;
  mainReadme: string | null;
} {
  const entry = buildHistoryEntry(input);
  const historyFile = appendHistory(entry);
  const history = readHistory();
  const { benchReadme, mainReadme } = renderReports(history);
  return { historyFile, benchReadme, mainReadme };
}

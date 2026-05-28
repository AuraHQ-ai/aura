/**
 * Append-only results log for the memory bench.
 *
 * Writes a compact, human-readable "fingerprint" of a run to
 * `apps/api/bench/RESULTS.md`: the commit it ran against, the corpus hash, the
 * config, and the per-category scores. The point is reproducibility — months
 * from now you can look at a row and know exactly which commit produced which
 * numbers, and whether a memory change actually moved the needle.
 *
 * Opt-in via `pnpm bench:memory ... --log` so the file only grows when you
 * have a result worth keeping (not on every throwaway local run).
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchScore, DatasetId } from "./types.js";

const MARKER = "<!-- BENCH_LOG_ENTRIES (newest first) -->";

const HEADER = `# Memory bench results log

Each entry below is a **fingerprint** of one benchmark run: the commit it ran
against, the corpus hash, the config, and the per-category scores. Treat it as a
watermark — when a memory change lands you can look back and see exactly which
commit produced which numbers.

Append an entry with \`pnpm bench:memory … --log\` (add \`--note="…"\` for
context). Newest entries are at the top. A \`-dirty\` suffix on the commit means
the run included uncommitted changes, so the SHA alone won't reproduce it.

${MARKER}
`;

export interface ResultsLogInput {
  runId: string;
  scores: BenchScore[];
  datasets: DatasetId[];
  subset: string;
  limit?: number;
  category?: string;
  corpusHash: string;
  totalDurationMs: number;
  note?: string;
}

function resolveCommit(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", {
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
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

function fmtPct(score: number | undefined): string {
  return score === undefined ? "—" : `${Math.round(score * 100)}%`;
}

function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  return `${Math.floor(totalSec / 60)}m${String(totalSec % 60).padStart(2, "0")}s`;
}

/** Build a single markdown fingerprint block for one run. */
export function buildResultsEntry(input: ResultsLogInput): string {
  const commit = resolveCommit();
  const now = new Date().toISOString().replace("T", " ").slice(0, 16);
  const sizing = input.limit && input.limit > 0 ? `limit=${input.limit}` : input.subset;
  const scope = `${input.datasets.join("+")}/${sizing}`;

  // Pivot scores into one row per (dataset, category): QA accuracy + recall@15.
  const rows = new Map<
    string,
    { dataset: string; category: string; qa?: number; recall?: number; n: number }
  >();
  for (const s of input.scores) {
    const key = `${s.dataset}|${s.category}`;
    const row = rows.get(key) ?? { dataset: s.dataset, category: s.category, n: 0 };
    if (s.scoreType === "qa_accuracy") {
      row.qa = s.score;
      row.n = Math.max(row.n, s.n);
    } else if (s.scoreType === "retrieval_recall_at_15") {
      row.recall = s.score;
      row.n = Math.max(row.n, s.n);
    }
    rows.set(key, row);
  }

  const sorted = [...rows.values()].sort(
    (a, b) => a.dataset.localeCompare(b.dataset) || a.category.localeCompare(b.category),
  );

  const lines: string[] = [];
  lines.push(`## ${now} UTC · \`${commit}\` · ${scope}`);
  lines.push("");
  lines.push(
    `- runId \`${input.runId}\` · corpus \`${input.corpusHash.slice(0, 12)}\` · runtime ${fmtDuration(input.totalDurationMs)}`,
  );
  if (input.category) lines.push(`- category filter: \`${input.category}\``);
  if (input.note) lines.push(`- note: ${input.note}`);
  lines.push("");
  lines.push("| dataset | category | QA acc | recall@15 | n |");
  lines.push("|---|---|---:|---:|---:|");
  for (const r of sorted) {
    lines.push(
      `| ${r.dataset} | ${r.category} | ${fmtPct(r.qa)} | ${fmtPct(r.recall)} | ${r.n} |`,
    );
  }
  return lines.join("\n");
}

export function defaultResultsPath(): string {
  const here = fileURLToPath(new URL(".", import.meta.url)); // bench/src/
  return resolve(here, "../RESULTS.md"); // bench/RESULTS.md
}

/**
 * Append a run fingerprint to RESULTS.md (newest first). Creates the file with
 * a header if it doesn't exist yet. Returns the path written.
 */
export function appendResultsLog(
  input: ResultsLogInput,
  file: string = defaultResultsPath(),
): string {
  const entry = buildResultsEntry(input);
  let content = existsSync(file) ? readFileSync(file, "utf8") : HEADER;
  if (!content.includes(MARKER)) {
    content = `${content.trimEnd()}\n\n${MARKER}\n`;
  }
  content = content.replace(MARKER, `${MARKER}\n\n${entry.trimEnd()}\n`);
  writeFileSync(file, content);
  return file;
}

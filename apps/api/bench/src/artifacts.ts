/**
 * Crash-safe run artifacts for the memory bench.
 *
 * Every run gets its own directory under `apps/api/bench/runs/<runId>/`:
 *
 *   run.log        full formatted log (via the logger file sink)
 *   cases.jsonl    one PerCaseResult per line, appended AS each case completes
 *   failures.jsonl one line per QA miss / recall miss, with the gold + answer
 *   manifest.json  config, models, corpus hash, git sha, counts, timings
 *   summary.txt    the human text summary
 *   scores.json    the aggregated BenchScore[]
 *
 * `cases.jsonl` is appended incrementally so a Ctrl-C (or crash) mid-run still
 * leaves a complete record of everything scored so far — which `--resume` reads
 * back to skip already-done cases. A `runs/latest` pointer file always names the
 * most recent run so `--resume` with no id can find it.
 *
 * The `runs/` tree is gitignored.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchScore, PerCaseResult } from "./types.js";

const RUNS_ROOT = fileURLToPath(new URL("../runs", import.meta.url));

export interface FailureRecord {
  caseId: string;
  dataset: string;
  category: string;
  kind: "qa" | "recall";
  question: string;
  goldAnswer: string | string[];
  modelAnswer: string;
  judgeVerdict: string;
  judgeRationale: string;
  retrievedMemoryIds: string[];
}

export interface RunArtifacts {
  runId: string;
  dir: string;
  logPath: string;
  /** Append one scored case to cases.jsonl. */
  appendCase(result: PerCaseResult): void;
  /** Append one miss to failures.jsonl. */
  appendFailure(failure: FailureRecord): void;
  /** Write manifest.json (overwrites). */
  writeManifest(manifest: Record<string, unknown>): void;
  /** Write the human-readable summary. */
  writeSummary(text: string): void;
  /** Write the aggregated scores. */
  writeScores(scores: BenchScore[]): void;
  /** Read previously-recorded cases (for --resume). Empty if none. */
  loadCases(): PerCaseResult[];
  /** Point `runs/latest` at this run. */
  markLatest(): void;
}

function resolveRunDir(runId: string): string {
  return path.join(RUNS_ROOT, runId);
}

/** Read the runId named by `runs/latest`, if present. */
export function readLatestRunId(): string | null {
  try {
    const p = path.join(RUNS_ROOT, "latest");
    return fs.readFileSync(p, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function createRunArtifacts(runId: string): RunArtifacts {
  const dir = resolveRunDir(runId);
  fs.mkdirSync(dir, { recursive: true });

  const casesPath = path.join(dir, "cases.jsonl");
  const failuresPath = path.join(dir, "failures.jsonl");
  const manifestPath = path.join(dir, "manifest.json");
  const summaryPath = path.join(dir, "summary.txt");
  const scoresPath = path.join(dir, "scores.json");
  const logPath = path.join(dir, "run.log");

  return {
    runId,
    dir,
    logPath,
    appendCase(result) {
      fs.appendFileSync(casesPath, JSON.stringify(result) + "\n");
    },
    appendFailure(failure) {
      fs.appendFileSync(failuresPath, JSON.stringify(failure) + "\n");
    },
    writeManifest(manifest) {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
    writeSummary(text) {
      fs.writeFileSync(summaryPath, text);
    },
    writeScores(scores) {
      fs.writeFileSync(scoresPath, JSON.stringify(scores, null, 2));
    },
    loadCases() {
      try {
        const raw = fs.readFileSync(casesPath, "utf8");
        return raw
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as PerCaseResult);
      } catch {
        return [];
      }
    },
    markLatest() {
      fs.writeFileSync(path.join(RUNS_ROOT, "latest"), runId);
    },
  };
}

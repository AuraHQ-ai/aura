/**
 * PR delta rendering for the memory bench.
 *
 * In CI the bench runs on the PR head and we want a "deploy-preview"-style
 * comment showing how the change moved each category against the *target
 * branch*. The baseline is the newest comparable entry in the base branch's
 * committed `history.jsonl` (git-native, auditable) — not the ephemeral run DB.
 *
 * "Comparable" means the same corpus AND the exact same sampled case set
 * (`corpusHash` + `caseSetHash`), plus the same dataset set and subset. Because
 * the sampler is deterministic (seeded `stratifiedSample` in fixtures.ts), a PR
 * `medium/both` run and the base `medium/both` entry share a case set and diff
 * like-for-like. When no comparable baseline exists (first adoption, corpus or
 * subset change) we render absolute scores with no fake deltas.
 *
 * Everything here is pure (no DB, no network) so it is trivially unit-testable
 * and runs in a tiny node step in the workflow.
 */

import type { HistoryEntry, HistoryScore } from "./results-log.js";

/** Hidden marker so the workflow can find + update its own comment in place. */
export const PR_COMMENT_MARKER = "<!-- aura-memory-bench -->";

/** Regression threshold (in score points, i.e. 0.02 == 2pp). */
export const REGRESSION_THRESHOLD = 0.02;

export interface BaselineScope {
  corpusHash: string;
  caseSetHash: string | null;
  datasets: string[];
  subset: string;
}

/** Parse a `history.jsonl` blob (tolerates an empty / missing-file string). */
export function parseHistoryText(text: string): HistoryEntry[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as HistoryEntry];
      } catch {
        return [];
      }
    });
}

function sameDatasets(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Return the newest history entry comparable to the current run's scope, or
 * null when none matches. Skips PR-attributed entries so a PR never diffs
 * against itself if base history happens to carry one.
 */
export function loadBaselineEntry(
  historyText: string,
  scope: BaselineScope,
): HistoryEntry | null {
  const entries = parseHistoryText(historyText);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.prNumber != null) continue;
    if (
      e.corpusHash === scope.corpusHash &&
      (e.caseSetHash ?? null) === (scope.caseSetHash ?? null) &&
      e.subset === scope.subset &&
      sameDatasets(e.datasets, scope.datasets)
    ) {
      return e;
    }
  }
  return null;
}

export interface CellDelta {
  dataset: string;
  category: string;
  n: number;
  beforeQa: number | null;
  afterQa: number | null;
  deltaQa: number | null;
  beforeRecall: number | null;
  afterRecall: number | null;
  deltaRecall: number | null;
}

export interface Regression {
  dataset: string;
  category: string;
  metric: "QA" | "recall@15";
  before: number;
  after: number;
  delta: number;
}

export interface OverallDelta {
  beforeQa: number | null;
  afterQa: number | null;
  deltaQa: number | null;
  beforeRecall: number | null;
  afterRecall: number | null;
  deltaRecall: number | null;
  n: number;
}

export interface BaselineDiff {
  hasBaseline: boolean;
  baselineCommit: string | null;
  baselineTimestamp: string | null;
  cells: CellDelta[];
  overall: OverallDelta;
  regressions: Regression[];
}

function delta(after: number | null, before: number | null): number | null {
  return after != null && before != null ? after - before : null;
}

function indexScores(scores: HistoryScore[]): Map<string, HistoryScore> {
  const m = new Map<string, HistoryScore>();
  for (const s of scores) m.set(`${s.dataset}|${s.category}`, s);
  return m;
}

/**
 * Diff a current run against a baseline entry (or null when there's no
 * comparable prior). Produces per-cell before/after/Δ for QA + recall, an
 * overall delta, and a regressions list (Δ <= -REGRESSION_THRESHOLD).
 */
export function diffEntries(
  current: HistoryEntry,
  baseline: HistoryEntry | null,
): BaselineDiff {
  const cur = indexScores(current.scores);
  const base = baseline ? indexScores(baseline.scores) : new Map<string, HistoryScore>();

  const keys = new Set<string>([...cur.keys(), ...base.keys()]);
  const cells: CellDelta[] = [];
  const regressions: Regression[] = [];

  for (const key of [...keys].sort()) {
    const [dataset, category] = key.split("|") as [string, string];
    const c = cur.get(key);
    const b = base.get(key);
    const cell: CellDelta = {
      dataset,
      category,
      n: c?.n ?? b?.n ?? 0,
      beforeQa: b?.qa ?? null,
      afterQa: c?.qa ?? null,
      deltaQa: delta(c?.qa ?? null, b?.qa ?? null),
      beforeRecall: b?.recall ?? null,
      afterRecall: c?.recall ?? null,
      deltaRecall: delta(c?.recall ?? null, b?.recall ?? null),
    };
    cells.push(cell);

    if (cell.deltaQa != null && cell.deltaQa <= -REGRESSION_THRESHOLD) {
      regressions.push({
        dataset,
        category,
        metric: "QA",
        before: cell.beforeQa!,
        after: cell.afterQa!,
        delta: cell.deltaQa,
      });
    }
    if (cell.deltaRecall != null && cell.deltaRecall <= -REGRESSION_THRESHOLD) {
      regressions.push({
        dataset,
        category,
        metric: "recall@15",
        before: cell.beforeRecall!,
        after: cell.afterRecall!,
        delta: cell.deltaRecall,
      });
    }
  }

  const overall: OverallDelta = {
    beforeQa: baseline?.overall.qa ?? null,
    afterQa: current.overall.qa,
    deltaQa: delta(current.overall.qa, baseline?.overall.qa ?? null),
    beforeRecall: baseline?.overall.recall ?? null,
    afterRecall: current.overall.recall,
    deltaRecall: delta(current.overall.recall, baseline?.overall.recall ?? null),
    n: current.overall.n,
  };

  return {
    hasBaseline: baseline != null,
    baselineCommit: baseline?.commit ?? null,
    baselineTimestamp: baseline?.timestamp ?? null,
    cells,
    overall,
    regressions,
  };
}

function fmtPct(v: number | null | undefined): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

function fmtDelta(d: number | null): string {
  if (d == null) return "—";
  const pp = Math.round(d * 100);
  const sign = pp > 0 ? "+" : "";
  const flag = pp <= -Math.round(REGRESSION_THRESHOLD * 100) ? " ⚠️" : "";
  return `${sign}${pp}pp${flag}`;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function fmtCost(usd: number | null | undefined): string {
  return usd == null ? "—" : `$${usd.toFixed(2)}`;
}

export interface CommentMeta {
  baseRef: string;
  headCommit: string;
  runId: string;
  runtimeMs: number;
  costUsd: number | null;
  scope: BaselineScope;
  runUrl?: string | null;
}

/** Render the sticky PR comment markdown. */
export function renderPrComment(diff: BaselineDiff, meta: CommentMeta): string {
  const lines: string[] = [];
  lines.push(PR_COMMENT_MARKER);
  lines.push("## Memory bench");
  lines.push("");

  const scopeStr = `\`${meta.scope.datasets.join("+")}/${meta.scope.subset}\``;
  if (diff.hasBaseline) {
    lines.push(
      `Δ vs target branch (\`${meta.baseRef}\` @ \`${diff.baselineCommit}\`) · scope ${scopeStr} · n=${diff.overall.n}`,
    );
  } else {
    lines.push(
      `No comparable baseline on \`${meta.baseRef}\` yet (corpus/case-set differs or first run) — showing absolute scores only. Scope ${scopeStr} · n=${diff.overall.n}`,
    );
  }
  lines.push("");

  lines.push("| Dataset | Category | QA before | QA after | QA Δ | recall before | recall after | recall Δ | n |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const c of diff.cells) {
    lines.push(
      `| ${c.dataset} | ${c.category} | ${fmtPct(c.beforeQa)} | ${fmtPct(c.afterQa)} | ${fmtDelta(c.deltaQa)} | ${fmtPct(c.beforeRecall)} | ${fmtPct(c.afterRecall)} | ${fmtDelta(c.deltaRecall)} | ${c.n} |`,
    );
  }
  const o = diff.overall;
  lines.push(
    `| **overall** | — | ${fmtPct(o.beforeQa)} | ${fmtPct(o.afterQa)} | ${fmtDelta(o.deltaQa)} | ${fmtPct(o.beforeRecall)} | ${fmtPct(o.afterRecall)} | ${fmtDelta(o.deltaRecall)} | ${o.n} |`,
  );
  lines.push("");

  if (diff.regressions.length > 0) {
    lines.push(
      `**⚠️ ${diff.regressions.length} regression(s) > ${Math.round(REGRESSION_THRESHOLD * 100)}pp** — justify in the PR description:`,
    );
    for (const r of diff.regressions) {
      lines.push(
        `- ${r.dataset}/${r.category} ${r.metric}: ${fmtPct(r.before)} → ${fmtPct(r.after)} (${fmtDelta(r.delta)})`,
      );
    }
    lines.push("");
  } else if (diff.hasBaseline) {
    lines.push(`No category regressed by more than ${Math.round(REGRESSION_THRESHOLD * 100)}pp.`);
    lines.push("");
  }

  lines.push(
    `<sub>run \`${meta.runId}\` · head \`${meta.headCommit}\` · runtime ${fmtDuration(meta.runtimeMs)} · cost ${fmtCost(meta.costUsd)}${meta.runUrl ? ` · [logs](${meta.runUrl})` : ""}</sub>`,
  );

  return lines.join("\n");
}

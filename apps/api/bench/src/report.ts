/**
 * Slack reporter for the memory bench.
 *
 * Posts a Block Kit message via the existing `safePostMessage` helper.
 * Format mirrors the example in #1043:
 *
 *   Memory bench — 2026-05-29 04:30 UTC
 *
 *   LoCoMo — 200 QA
 *     Category                   |  Score | Δ vs prior
 *     temporal                   |    38% |    -4pp  ⚠
 *     multi_hop                  |    41% |    -1pp
 *     ...
 *
 *   Retrieval recall@15 — LoCoMo
 *     Category                   | Recall | Δ vs prior
 *     temporal                   |    68% |    +1pp
 *     ...
 *   Cost: $4.21  Runtime: 8m12s  Commit: a1b2c3d
 */

import { WebClient } from "@slack/web-api";
import { safePostMessage } from "../../src/lib/slack-messaging.js";
import { logger } from "../../src/lib/logger.js";
import type { ContextEfficiency } from "./score.js";
import type { BenchRunConfig, BenchScore } from "./types.js";

const REGRESSION_THRESHOLD = 0.02; // 2pp per #1043 acceptance criteria.

function fmtPct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

// Shared column widths so every row (and the header) lines up exactly.
const CAT_W = 26;
const SCORE_W = 6;

/** One aligned table row: `  Category… | Score | Δ`. */
function row(category: string, score: string, delta: string): string {
  return `  ${category.padEnd(CAT_W)} | ${score.padStart(SCORE_W)} | ${delta}`;
}

function fmtDelta(delta: number | null): string {
  if (delta === null) return "—".padStart(6);
  const pp = Math.round(delta * 100);
  const flag = pp <= -2 ? "  ⚠" : "";
  const body = pp === 0 ? "0pp" : `${pp > 0 ? "+" : ""}${pp}pp`;
  return body.padStart(6) + flag;
}

function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/** Compact token count: 980 → "980", 1240 → "1.2K". */
function fmtTokens(tokens: number): string {
  const t = Math.round(tokens);
  if (t < 1000) return String(t);
  return `${(t / 1000).toFixed(1)}K`;
}

interface ReportInput {
  scores: BenchScore[];
  deltas: Map<string, { prior: number | null; delta: number | null; priorRunId: string | null }>;
  config: BenchRunConfig;
  totalDurationMs: number;
  totalCostUsd?: number;
  /**
   * Optional memory-context efficiency aggregate (mean tokens/mems injected
   * into the answerer). Rendered as a small table after the recall lanes.
   */
  contextEfficiency?: ContextEfficiency;
}

/**
 * Build a plain-text summary safe for terminal output. Also serves as the
 * Slack fallback text when blocks fail to render.
 */
export function buildTextSummary(input: ReportInput): string {
  const { scores, deltas, config, totalDurationMs, totalCostUsd } = input;
  const now = new Date().toISOString().replace("T", " ").slice(0, 16);
  const lines: string[] = [`Memory bench — ${now} UTC`];

  // Group QA accuracy by dataset
  const qaByDataset = new Map<string, BenchScore[]>();
  const recallByDataset = new Map<string, BenchScore[]>();
  for (const s of scores) {
    if (s.scoreType === "qa_accuracy") {
      if (!qaByDataset.has(s.dataset)) qaByDataset.set(s.dataset, []);
      qaByDataset.get(s.dataset)!.push(s);
    } else if (s.scoreType === "retrieval_recall_at_15") {
      if (!recallByDataset.has(s.dataset)) recallByDataset.set(s.dataset, []);
      recallByDataset.get(s.dataset)!.push(s);
    }
  }

  for (const [dataset, list] of qaByDataset) {
    const totalN = list.reduce((acc, s) => acc + s.n, 0);
    lines.push("");
    lines.push(`${prettyDataset(dataset)} — ${totalN} QA`);
    lines.push(row("Category", "Score", "Δ vs prior"));
    for (const s of list.sort((a, b) => a.category.localeCompare(b.category))) {
      const d = deltas.get(`${s.dataset}|${s.category}|${s.scoreType}`);
      lines.push(row(s.category, fmtPct(s.score), fmtDelta(d?.delta ?? null)));
    }
  }

  for (const [dataset, list] of recallByDataset) {
    lines.push("");
    lines.push(`Retrieval recall@15 — ${prettyDataset(dataset)}`);
    lines.push(row("Category", "Recall", "Δ vs prior"));
    for (const s of list.sort((a, b) => a.category.localeCompare(b.category))) {
      const d = deltas.get(`${s.dataset}|${s.category}|${s.scoreType}`);
      lines.push(row(s.category, fmtPct(s.score), fmtDelta(d?.delta ?? null)));
    }
  }

  const eff = input.contextEfficiency;
  if (eff && eff.overall.n > 0) {
    lines.push("");
    lines.push("Context efficiency — memory injected per answer");
    lines.push(row("Dataset", "Tokens", "Mems"));
    const datasets = [...eff.byDataset.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [dataset, stat] of datasets) {
      lines.push(
        row(
          prettyDataset(dataset),
          fmtTokens(stat.meanTokens),
          String(Math.round(stat.meanCount)),
        ),
      );
    }
    if (datasets.length > 1) {
      lines.push(
        row(
          "(overall)",
          fmtTokens(eff.overall.meanTokens),
          String(Math.round(eff.overall.meanCount)),
        ),
      );
    }
  }

  lines.push("");
  const costStr = totalCostUsd ? `Cost: $${totalCostUsd.toFixed(2)}  ` : "";
  const sha = config.gitSha ? `  Commit: ${config.gitSha.slice(0, 7)}` : "";
  lines.push(`${costStr}Runtime: ${fmtDuration(totalDurationMs)}${sha}`);
  return lines.join("\n");
}

function prettyDataset(id: string): string {
  if (id === "locomo") return "LoCoMo";
  if (id === "longmemeval") return "LongMemEval";
  if (id === "toy") return "Toy";
  return id;
}

/** Build the Block Kit blocks for the Slack post. */
function buildBlocks(input: ReportInput): any[] {
  const summary = buildTextSummary(input);
  const hasRegression = [...input.deltas.values()].some(
    (d) => d.delta !== null && d.delta <= -REGRESSION_THRESHOLD,
  );
  const headerEmoji = hasRegression ? ":warning:" : ":bar_chart:";
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${headerEmoji} Memory bench — ${input.config.runId}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "```\n" + summary + "\n```" },
    },
  ];
}

/**
 * Post the bench report to Slack. Returns the message ts on success.
 *
 * Channel is taken from `MEMORY_BENCH_SLACK_CHANNEL`. If that env var is
 * unset, this is a no-op (we don't want to silently spam a default channel).
 */
export async function postReport(input: ReportInput): Promise<string | null> {
  const channel = process.env.MEMORY_BENCH_SLACK_CHANNEL;
  if (!channel) {
    logger.info("bench: MEMORY_BENCH_SLACK_CHANNEL not set — skipping Slack post");
    return null;
  }
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    logger.warn("bench: SLACK_BOT_TOKEN not set — cannot post bench report");
    return null;
  }
  const client = new WebClient(botToken);
  const text = `Memory bench — ${input.config.runId}`;
  const blocks = buildBlocks(input);

  const result = await safePostMessage(client, {
    channel,
    text,
    blocks,
  });
  return result.ts ?? null;
}

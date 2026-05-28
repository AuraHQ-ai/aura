import { WebClient } from "@slack/web-api";
import { safePostMessage } from "../lib/slack-messaging.js";
import type { BenchRunResult } from "./types.js";
import type { PriorScoreRow } from "./score.js";

function formatPct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function formatDelta(current: number, prior: number | undefined): string {
  if (prior === undefined) return "  —";
  const pp = Math.round((current - prior) * 100);
  const sign = pp > 0 ? "+" : "";
  const warn = pp <= -2 ? " ⚠" : "";
  return ` ${sign}${pp}pp${warn}`;
}

export function buildBenchSlackBlocks(
  result: BenchRunResult,
  priors: PriorScoreRow[],
): { text: string; blocks: unknown[] } {
  const priorMap = new Map(priors.map((p) => [`${p.dataset}:${p.category}:${p.scoreType}`, p.score]));

  const lines: string[] = [
    `*Memory bench* — ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    `Run \`${result.runId}\` · commit \`${result.gitSha.slice(0, 7)}\``,
    "",
  ];

  const byDataset = new Map<string, typeof result.scores>();
  for (const s of result.scores) {
    const list = byDataset.get(s.dataset) ?? [];
    list.push(s);
    byDataset.set(s.dataset, list);
  }

  for (const [dataset, scores] of byDataset) {
    lines.push(`*${dataset}*`);
    for (const s of scores.sort((a, b) => a.category.localeCompare(b.category))) {
      const prior = priorMap.get(`${s.dataset}:${s.category}:${s.scoreType}`);
      const label = s.scoreType === "retrieval_recall_at_15" ? "recall@15" : "QA";
      lines.push(
        `  ${s.category} (${label})  ${formatPct(s.score)}${formatDelta(s.score, prior)}  (${s.nCorrect}/${s.n})`,
      );
    }
    lines.push("");
  }

  lines.push(
    `Cost: $${result.costUsd.toFixed(2)} · Runtime: ${Math.round(result.durationMs / 1000)}s · corpus ${result.corpusHash}`,
  );

  const text = lines.join("\n");
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
  ];

  return { text, blocks };
}

export async function postBenchSlackReport(
  result: BenchRunResult,
  priors: PriorScoreRow[],
): Promise<void> {
  const channel = process.env.MEMORY_BENCH_SLACK_CHANNEL;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!channel || !token) {
    console.log("Skipping Slack report (MEMORY_BENCH_SLACK_CHANNEL or SLACK_BOT_TOKEN unset)");
    console.log(buildBenchSlackBlocks(result, priors).text);
    return;
  }

  const client = new WebClient(token);
  const { text, blocks } = buildBenchSlackBlocks(result, priors);
  await safePostMessage(client, { channel, text, blocks: blocks as never });
}

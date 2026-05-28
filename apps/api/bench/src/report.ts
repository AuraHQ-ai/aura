import { WebClient } from "@slack/web-api";
import { safePostMessage } from "../../src/lib/slack-messaging.js";
import type { BenchRunResult } from "./types.js";

function percent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function delta(delta?: number): string {
  if (delta === undefined) return "new";
  const pp = Math.round(delta * 100);
  if (pp === 0) return "0pp";
  return `${pp > 0 ? "+" : ""}${pp}pp`;
}

export function formatBenchReport(result: BenchRunResult): string {
  const lines = [
    `Memory bench -- ${new Date().toISOString()}`,
    `Run: ${result.runId}`,
    result.gitSha ? `Commit: ${result.gitSha}` : undefined,
    `Runtime: ${Math.round(result.durationMs / 1000)}s`,
    "",
    "Dataset | Category | Metric | Score | Delta",
    "--- | --- | --- | --- | ---",
  ].filter((line): line is string => line !== undefined);

  for (const aggregate of result.aggregates) {
    lines.push([
      aggregate.dataset,
      aggregate.category,
      aggregate.scoreType,
      `${percent(aggregate.score)} (${aggregate.nCorrect}/${aggregate.n})`,
      delta(aggregate.delta),
    ].join(" | "));
  }

  return lines.join("\n");
}

export async function postBenchReport(result: BenchRunResult): Promise<void> {
  const channel = process.env.MEMORY_BENCH_SLACK_CHANNEL;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!channel || !token) {
    throw new Error("MEMORY_BENCH_SLACK_CHANNEL and SLACK_BOT_TOKEN are required for --post-slack");
  }

  const text = formatBenchReport(result);
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Memory bench* -- ${result.runId}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```" + text.slice(0, 2900) + "```",
      },
    },
  ];

  const client = new WebClient(token);
  await safePostMessage(client, {
    channel,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  });
}

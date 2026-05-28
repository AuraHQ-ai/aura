import { WebClient } from "@slack/web-api";
import { safePostMessage } from "../lib/slack-messaging.js";
import type { BenchRunResult } from "./types.js";

export function formatBenchReport(result: BenchRunResult): string {
  const lines: string[] = [
    `Memory bench — run ${result.runId}`,
    `Commit: ${result.gitSha?.slice(0, 7) ?? "?"} · corpus ${result.corpusHash}`,
    `Models: extract=${result.models.extraction} answer=${result.models.answerer} judge=${result.models.judge}`,
    `Duration: ${Math.round(result.durationMs / 1000)}s`,
    "",
  ];

  if (!result.ok) {
    lines.push(`FAILED: ${result.error ?? "unknown"}`);
    return lines.join("\n");
  }

  for (const s of result.scores.sort(
    (a, b) =>
      a.dataset.localeCompare(b.dataset) ||
      a.category.localeCompare(b.category) ||
      a.scoreType.localeCompare(b.scoreType),
  )) {
    const pct = Math.round(s.score * 100);
    const delta =
      s.deltaPp !== undefined ? ` (${s.deltaPp >= 0 ? "+" : ""}${s.deltaPp}pp)` : "";
    lines.push(
      `  ${s.dataset} / ${s.category} / ${s.scoreType}: ${pct}% (${s.nCorrect}/${s.n})${delta}`,
    );
  }
  return lines.join("\n");
}

export async function postBenchSlackReport(result: BenchRunResult): Promise<void> {
  const channel = process.env.MEMORY_BENCH_SLACK_CHANNEL;
  const token = process.env.SLACK_BOT_TOKEN;
  const text = formatBenchReport(result);
  if (!channel || !token) {
    console.log(text);
    return;
  }
  const client = new WebClient(token);
  await safePostMessage(client, { channel, text });
}

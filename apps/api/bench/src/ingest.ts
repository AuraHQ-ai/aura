import type { ThreadMessage } from "../../src/memory/store.js";
import { extractMemoriesFromTranscript } from "../../src/memory/extract.js";
import type { BenchCase, BenchSession } from "./types.js";

function sessionThreadTs(session: BenchSession): string {
  const seconds = Math.floor(new Date(session.timestamp).getTime() / 1000);
  return `${seconds}.000000`;
}

function toThreadMessages(session: BenchSession): ThreadMessage[] {
  const base = new Date(session.timestamp).getTime();
  return session.turns.map((turn, index) => ({
    role: turn.role,
    userId: turn.role === "assistant" ? "bench:assistant" : "bench:user",
    content: turn.content,
    createdAt: new Date(base + index * 1000),
  }));
}

export async function ingestBenchCase(
  benchCase: BenchCase,
  workspaceId: string,
  extractionModelId?: string,
): Promise<void> {
  for (const session of benchCase.sessions) {
    const messages = toThreadMessages(session);
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    const diaIds = session.turns
      .map((turn, index) => turn.diaId ?? `${session.id}:${index + 1}`)
      .filter(Boolean);

    await extractMemoriesFromTranscript(messages, {
      userMessage: lastUser?.content ?? messages.at(-1)?.content ?? "",
      assistantResponse: lastAssistant?.content ?? "",
      userId: "bench:user",
      displayName: "Benchmark User",
      channelType: "dm",
      workspaceId,
      channelId: `bench:${benchCase.id}`,
      threadTs: sessionThreadTs(session),
      createdAt: new Date(session.timestamp),
      benchProvenance: {
        caseId: benchCase.id,
        sessionId: session.id,
        diaIds,
        source: benchCase.source,
      },
      extractionModelId,
    });
  }
}

export async function ingestBenchCases(
  cases: BenchCase[],
  workspaceId: string,
  extractionModelId?: string,
  onProgress?: (completed: number, total: number) => void,
): Promise<void> {
  let completed = 0;
  for (const benchCase of cases) {
    await ingestBenchCase(benchCase, workspaceId, extractionModelId);
    completed += 1;
    onProgress?.(completed, cases.length);
  }
}

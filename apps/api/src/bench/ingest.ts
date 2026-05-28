import type { BenchCase } from "./types.js";
import type { ThreadMessage } from "../memory/store.js";
import { extractMemoriesFromTranscript, type ExtractionContext } from "../memory/extract.js";
import { storeMessage } from "../memory/store.js";
import { logger } from "../lib/logger.js";

function parseBenchTimestamp(ts: string): Date {
  const m = ts.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (m) {
    return new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z`);
  }
  return new Date(ts);
}

/** Use corpus session id as thread key so recall@K can match evidenceSessionIds. */
function sessionThreadTs(sessionId: string): string {
  return sessionId;
}

function benchCasesToThreadMessages(
  benchCase: BenchCase,
  sessionIndex: number,
): ThreadMessage[] {
  const session = benchCase.sessions[sessionIndex];
  const createdAt = parseBenchTimestamp(session.timestamp);

  return session.turns.map((turn) => ({
    role: turn.role,
    content: turn.content,
    userId: turn.role === "user" ? `bench:${benchCase.id}:user` : "bench:aura",
    createdAt,
  }));
}

/**
 * Replay all sessions for a bench case through the real extractor.
 */
export async function ingestBenchCase(
  benchCase: BenchCase,
  workspaceId: string,
): Promise<void> {
  const channelId = `bench:${benchCase.id}`;

  for (let sIdx = 0; sIdx < benchCase.sessions.length; sIdx++) {
    const session = benchCase.sessions[sIdx];
    const threadTs = sessionThreadTs(session.id);
    const createdAt = parseBenchTimestamp(session.timestamp);
    const threadMessages = benchCasesToThreadMessages(benchCase, sIdx);

    let lastUser = "";
    let lastAssistant = "";

    for (let turnIdx = 0; turnIdx < session.turns.length; turnIdx++) {
      const turn = session.turns[turnIdx];
      const externalId = `${benchCase.id}:${session.id}:${turnIdx}`;
      const slackTs = `${threadTs.replace(".000000", "")}.${String(turnIdx).padStart(6, "0")}`;

      try {
        await storeMessage({
          externalId,
          slackTs,
          slackThreadTs: threadTs,
          channelId,
          channelType: "public_channel",
          userId: turn.role === "user" ? `bench:${benchCase.id}:user` : "bench:aura",
          role: turn.role,
          content: turn.content,
          workspaceId,
          createdAt,
        });
      } catch {
        logger.warn("Bench message store skipped", { caseId: benchCase.id });
      }

      if (turn.role === "user") lastUser = turn.content;
      else lastAssistant = turn.content;
    }

    const ctx: ExtractionContext = {
      userMessage: lastUser || session.turns.find((t) => t.role === "user")?.content || "",
      assistantResponse: lastAssistant,
      userId: `bench:${benchCase.id}:user`,
      channelType: "public_channel",
      channelId,
      threadTs,
      workspaceId,
      createdAt,
      displayName: "Bench User",
    };

    await extractMemoriesFromTranscript(threadMessages, ctx);
  }
}

export async function ingestCases(
  cases: BenchCase[],
  workspaceId: string,
  concurrency: number,
): Promise<void> {
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < cases.length) {
      const i = idx++;
      const c = cases[i];
      logger.info(`Bench ingest ${i + 1}/${cases.length}: ${c.id}`);
      await ingestBenchCase(c, workspaceId);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));
}

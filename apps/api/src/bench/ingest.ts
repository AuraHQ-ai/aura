import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  extractMemoriesFromTranscript,
  type ExtractionContext,
} from "../memory/extract.js";
import { storeMessage } from "../memory/store.js";
import type { ThreadMessage } from "../memory/store.js";
import { logger } from "../lib/logger.js";
import type { BenchCase } from "./types.js";

async function stampProvenance(
  workspaceId: string,
  threadTs: string,
  benchCase: BenchCase,
  sessionId: string,
  diaIds: string[],
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE memories
      SET bench_provenance = ${JSON.stringify({
        datasetId: benchCase.source,
        conversationId: benchCase.id,
        sessionIds: [sessionId],
        diaIds,
      })}::jsonb
      WHERE workspace_id = ${workspaceId}
        AND source_thread_ts = ${threadTs}
        AND bench_provenance IS NULL
    `);
  } catch (error) {
    logger.warn("bench: provenance stamp failed", {
      caseId: benchCase.id,
      error: String(error).slice(0, 200),
    });
  }
}

export async function ingestBenchCase(
  benchCase: BenchCase,
  workspaceId: string,
  extractionModelId: string,
): Promise<void> {
  const channelId = `bench:${benchCase.id}`;

  for (const session of benchCase.sessions) {
    const epochSec = Math.floor(new Date(session.timestamp).getTime() / 1000);
    const threadTs = `${epochSec}.000000`;
    const sessionDate = new Date(session.timestamp);
    const threadMessages: ThreadMessage[] = [];
    const sessionDiaIds: string[] = [];

    let lastUser = "";
    let lastAssistant = "";

    for (const [turnIdx, turn] of session.turns.entries()) {
      if (turn.diaId) sessionDiaIds.push(turn.diaId);
      const turnTs = new Date(sessionDate.getTime() + turnIdx * 60_000);
      const externalId = `${benchCase.id}:${session.id}:${turn.diaId ?? turnIdx}`;

      threadMessages.push({
        role: turn.role,
        content: turn.content,
        userId:
          turn.role === "user"
            ? `bench:${turn.speaker ?? benchCase.id}:user`
            : "bench:aura",
        createdAt: turnTs,
      });

      try {
        await storeMessage({
          externalId,
          workspaceId,
          slackTs: `${epochSec + turnIdx}.000000`,
          slackThreadTs: threadTs,
          channelId,
          channelType: "public_channel",
          userId:
            turn.role === "user"
              ? `bench:${turn.speaker ?? benchCase.id}:user`
              : "bench:aura",
          role: turn.role,
          content: turn.content,
          createdAt: turnTs,
        } as Parameters<typeof storeMessage>[0]);
      } catch {
        logger.warn("bench: storeMessage skipped", { caseId: benchCase.id });
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
      createdAt: sessionDate,
      displayName: "Bench User",
      extractionModelId,
    };

    await extractMemoriesFromTranscript(threadMessages, ctx);
    await stampProvenance(workspaceId, threadTs, benchCase, session.id, sessionDiaIds);
  }
}

export async function ingestCases(
  cases: BenchCase[],
  workspaceId: string,
  extractionModelId: string,
  concurrency: number,
): Promise<void> {
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < cases.length) {
      const i = idx++;
      logger.info(`Bench ingest ${i + 1}/${cases.length}: ${cases[i].id}`);
      await ingestBenchCase(cases[i], workspaceId, extractionModelId);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()),
  );
}

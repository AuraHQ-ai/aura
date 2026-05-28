/**
 * Ingest a BenchCase's conversation history into the real extractor →
 * memory pipeline, scoped to a single bench workspace.
 *
 * Two important invariants:
 *
 *   1. The `sourceThreadTs` written on each message AND on every memory
 *      extracted from that session equals the corpus `session.id`. This
 *      makes deterministic retrieval-recall@K a one-liner: hit ⇔ any
 *      retrieved memory has `sourceThreadTs ∈ evidenceSessionIds`.
 *   2. The extractor stamps every memory's `bench_provenance` column with
 *      caseId / sessionId / diaIds, atomically at insert time, via the
 *      benchProvenance field on ExtractionContext. No separate UPDATE pass.
 *
 * `created_at` on messages and `valid_from` on memories come from the
 * corpus session timestamp — critical for temporal-reasoning categories
 * and the future bi-temporal work (#1040).
 */

import { sql } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { storeMessage } from "../../src/memory/store.js";
import {
  extractMemoriesFromTranscript,
  type ExtractionContext,
} from "../../src/memory/extract.js";
import type { ThreadMessage } from "../../src/memory/store.js";
import { logger } from "../../src/lib/logger.js";
import type { BenchCase } from "./types.js";

/**
 * Synthetic per-bench Slack user id for a corpus speaker. Deterministic so
 * thread participants stay stable across runs.
 */
function speakerToUserId(caseId: string, speaker: string | undefined): string {
  if (!speaker) return `bench:${caseId}:user`;
  const slug = speaker.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `bench:${caseId}:${slug || "user"}`;
}

/**
 * Ingest a single BenchCase into the workspace. Per-session extraction
 * mirrors how production sees a Slack thread, so we exercise the same
 * reconciliation path (CREATE / UPDATE / DELETE ops over existing
 * memories from earlier sessions in the same case).
 */
export async function ingestCase(
  benchCase: BenchCase,
  workspaceId: string,
  extractionModelId: string,
): Promise<{ memoriesAdded: number; sessionsIngested: number }> {
  const channelId = `bench:${benchCase.id}`;
  let sessionsIngested = 0;

  const beforeRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM memories WHERE workspace_id = ${workspaceId}
  `)) as any;
  const before = Number((beforeRows.rows ?? beforeRows)[0]?.n ?? 0);

  for (const session of benchCase.sessions) {
    // Use the raw corpus session id as the thread key. This is what makes
    // retrieval-recall scoring a simple set membership check —
    // m.sourceThreadTs ∈ evidenceSessionIds.
    const threadTs = session.id;
    const sessionDate = new Date(session.timestamp);

    const threadMessages: ThreadMessage[] = [];
    const diaIds: string[] = [];

    for (const [turnIdx, turn] of session.turns.entries()) {
      const userId = speakerToUserId(benchCase.id, turn.speaker);
      // Per-turn timestamp inside the session window so retrieval ordering
      // is well-defined when categories are temporal.
      const turnTs = new Date(sessionDate.getTime() + turnIdx * 60_000);

      const diaId = turn.diaId ?? `${session.id}:${turnIdx + 1}`;
      diaIds.push(diaId);

      const externalId = `${channelId}:${session.id}:${diaId}`;
      try {
        await storeMessage({
          externalId,
          workspaceId,
          // slackTs deliberately encodes the session epoch so messages
          // inside one session sort together; bench workspaces aren't
          // expected to interop with the real Slack ts space.
          slackTs: `${Math.floor(turnTs.getTime() / 1000)}.${String(turnIdx).padStart(6, "0")}`,
          slackThreadTs: threadTs,
          channelId,
          channelType: "public_channel",
          userId,
          role: turn.role,
          content: turn.content,
          createdAt: turnTs,
        } as any);
      } catch (error) {
        logger.warn("bench: storeMessage failed (continuing)", {
          externalId,
          error: String(error).slice(0, 200),
        });
      }

      threadMessages.push({
        role: turn.role,
        userId,
        content: turn.content,
        createdAt: turnTs,
      });
    }

    if (threadMessages.length === 0) continue;

    const lastUser =
      [...threadMessages].reverse().find((m) => m.role === "user") ??
      threadMessages[threadMessages.length - 1];
    const lastAssistant = [...threadMessages]
      .reverse()
      .find((m) => m.role === "assistant");

    const ctx: ExtractionContext = {
      userMessage: lastUser.content,
      assistantResponse: lastAssistant?.content ?? "",
      userId: lastUser.userId,
      channelType: "public_channel",
      channelId,
      threadTs,
      workspaceId,
      extractionModelId,
      triggerRole: "user",
      // valid_from = session timestamp. Critical for temporal categories.
      createdAt: sessionDate,
      displayName: lastUser.userId.replace(/^bench:/, ""),
      // Stamped atomically with the memory inserts — no follow-up UPDATE.
      benchProvenance: {
        datasetId: benchCase.source,
        caseId: benchCase.id,
        conversationId: benchCase.id,
        sessionId: session.id,
        sessionIds: [session.id],
        diaIds,
      },
    };

    try {
      await extractMemoriesFromTranscript(threadMessages, ctx);
      sessionsIngested++;
    } catch (error) {
      logger.warn("bench: extraction failed for session", {
        caseId: benchCase.id,
        sessionId: session.id,
        error: String(error).slice(0, 200),
      });
    }
  }

  const afterRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM memories WHERE workspace_id = ${workspaceId}
  `)) as any;
  const after = Number((afterRows.rows ?? afterRows)[0]?.n ?? 0);

  return {
    memoriesAdded: Math.max(0, after - before),
    sessionsIngested,
  };
}

/**
 * Ingest a list of cases, optionally in parallel.
 *
 * Concurrency >1 speeds up the full-corpus run substantially: extraction
 * is dominated by LLM latency, not DB throughput. The pool pattern keeps
 * memory bounded — at most `concurrency` extractions in flight at once.
 */
export async function ingestCases(
  cases: BenchCase[],
  workspaceId: string,
  extractionModelId: string,
  concurrency = 2,
  onProgress?: (done: number, total: number) => void,
): Promise<{ totalMemories: number; totalSessions: number }> {
  // De-dupe by conversation: LoCoMo packs many QA pairs per conversation,
  // and they all share one session set. Re-extracting N times would waste
  // money and produce duplicate memories.
  const seen = new Set<string>();
  const unique: BenchCase[] = [];
  for (const c of cases) {
    const key = `${c.source}:${JSON.stringify(c.sessions.map((s) => s.id))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  logger.info(
    `bench: ingesting ${unique.length} unique conversation(s) from ${cases.length} case(s)`,
    { workspaceId, concurrency },
  );

  let totalMemories = 0;
  let totalSessions = 0;
  let done = 0;
  let idx = 0;

  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= unique.length) return;
      const r = await ingestCase(unique[i], workspaceId, extractionModelId);
      totalMemories += r.memoriesAdded;
      totalSessions += r.sessionsIngested;
      done += 1;
      onProgress?.(done, unique.length);
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, unique.length)) },
    () => worker(),
  );
  await Promise.all(workers);

  return { totalMemories, totalSessions };
}

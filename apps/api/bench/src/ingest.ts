/**
 * Ingest a BenchCase's conversation history into the real extractor →
 * memory pipeline, scoped to a single bench workspace.
 *
 * We mint synthetic Slack identifiers (`bench:{conv_id}` channels,
 * `{sessionEpoch}.000000` thread ts, `bench:{speaker}` user IDs) so the
 * harness never collides with real Slack data. Importantly we set
 * `created_at` on the inserted messages and `valid_from` on the memories
 * to the corpus timestamp — critical for temporal-reasoning categories.
 */

import { sql } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { memories } from "@aura/db/schema";
import { storeMessage } from "../../src/memory/store.js";
import {
  extractMemoriesFromTranscript,
  type ExtractionContext,
} from "../../src/memory/extract.js";
import type { ThreadMessage } from "../../src/memory/store.js";
import { logger } from "../../src/lib/logger.js";
import type { BenchCase } from "./types.js";

/**
 * Stamp every memory just created for this case with its provenance.
 *
 * The extractor stores memories without our bench fields (it has no idea
 * the harness is running). After each extraction call we backfill
 * `bench_provenance` on the freshly-inserted rows by looking up memories
 * with the same workspace + sourceThreadTs.
 */
async function stampProvenance(
  workspaceId: string,
  threadTs: string,
  benchCase: BenchCase,
  sessionId: string,
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE memories
      SET bench_provenance = ${JSON.stringify({
        datasetId: benchCase.source,
        conversationId: benchCase.id,
        sessionIds: [sessionId],
        diaIds: benchCase.evidenceDiaIds ?? [],
      })}::jsonb
      WHERE workspace_id = ${workspaceId}
        AND source_thread_ts = ${threadTs}
        AND bench_provenance IS NULL
    `);
  } catch (error) {
    logger.warn("bench: failed to stamp provenance (continuing)", {
      workspaceId,
      threadTs,
      error: String(error).slice(0, 200),
    });
  }
}

/**
 * Ingest a single BenchCase into the workspace.
 *
 * One session = one thread = one extraction call. This mirrors how
 * production extraction sees a Slack thread, so we exercise the same
 * reconciliation code path (CREATE / UPDATE / DELETE ops over existing
 * memories from earlier sessions in the same case).
 */
export async function ingestCase(
  benchCase: BenchCase,
  workspaceId: string,
): Promise<{ memoriesAdded: number; sessionsIngested: number }> {
  const channelId = `bench:${benchCase.id}`;
  let sessionsIngested = 0;

  // Snapshot of memory count at the start so we can report a delta.
  const beforeRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM memories WHERE workspace_id = ${workspaceId}
  `)) as any;
  const before = Number(
    (beforeRows.rows ?? beforeRows)[0]?.n ?? 0,
  );

  for (const session of benchCase.sessions) {
    // Synthetic thread_ts that encodes the session timestamp.
    const epochSec = Math.floor(new Date(session.timestamp).getTime() / 1000);
    const threadTs = `${epochSec}.000000`;
    const sessionDate = new Date(session.timestamp);

    const threadMessages: ThreadMessage[] = [];

    for (const [turnIdx, turn] of session.turns.entries()) {
      const userId = turn.speaker
        ? `bench:${turn.speaker.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`
        : `bench:user`;
      // Distinct per-turn timestamp so retrieval ordering is well-defined.
      // Add 60 seconds per turn — keeps sub-minute granularity for the
      // temporal-reasoning checks while staying inside the session window.
      const turnTs = new Date(sessionDate.getTime() + turnIdx * 60_000);

      const externalId = `${channelId}:${session.id}:${turn.diaId ?? turnIdx}`;
      const role = turn.role;
      const content = turn.content;

      try {
        await storeMessage({
          externalId,
          workspaceId,
          slackTs: `${epochSec + turnIdx}.000000`,
          slackThreadTs: threadTs,
          channelId,
          channelType: "public_channel",
          userId,
          role,
          content,
          createdAt: turnTs,
        } as any);
      } catch (error) {
        logger.warn("bench: storeMessage failed (continuing)", {
          externalId,
          error: String(error).slice(0, 200),
        });
      }

      threadMessages.push({
        role,
        userId,
        content,
        createdAt: turnTs,
      });
    }

    if (threadMessages.length === 0) continue;

    // The "last user message" is what the extractor uses to retrieve
    // existing memories during reconciliation.
    const lastUser =
      [...threadMessages].reverse().find((m) => m.role === "user") ??
      threadMessages[threadMessages.length - 1];

    const ctx: ExtractionContext = {
      userMessage: lastUser.content,
      assistantResponse: "",
      userId: lastUser.userId,
      channelType: "public_channel",
      channelId,
      threadTs,
      workspaceId,
      triggerRole: "user",
      // valid_from = session timestamp. Critical for temporal categories.
      createdAt: sessionDate,
      displayName: lastUser.userId.replace(/^bench:/, ""),
    };

    try {
      await extractMemoriesFromTranscript(threadMessages, ctx);
      await stampProvenance(workspaceId, threadTs, benchCase, session.id);
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

/** Ingest all unique session-sets across a list of cases. */
export async function ingestCases(
  cases: BenchCase[],
  workspaceId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ totalMemories: number; totalSessions: number }> {
  let totalMemories = 0;
  let totalSessions = 0;

  // De-dupe by conversation: many LoCoMo cases share the same session set.
  // We key on the JSON-serialised session list to avoid re-extracting the
  // same transcripts N times.
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
    { workspaceId },
  );

  for (const [i, c] of unique.entries()) {
    const r = await ingestCase(c, workspaceId);
    totalMemories += r.memoriesAdded;
    totalSessions += r.sessionsIngested;
    onProgress?.(i + 1, unique.length);
  }
  return { totalMemories, totalSessions };
}

// We import the memories table only to make sure tsc keeps the reference alive
// (and so future contributors can extend `stampProvenance` with Drizzle's
// type-safe update helpers without retyping the import).
void memories;

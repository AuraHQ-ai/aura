/**
 * Ingest a BenchCase's conversation history into the real extractor →
 * memory pipeline, scoped to a single bench workspace.
 *
 * The pipeline is split into two independent stages so the harness can replay
 * just the part you're iterating on (see runner.ts `--from`):
 *
 *   1. `storeMessagesForCases`   — store + embed raw messages (the `messages`
 *                                  table). Embeddings are batched per
 *                                  conversation and rows are bulk-inserted.
 *   2. `extractMemoriesForCases` — run the real extractor over each session's
 *                                  transcript, producing `memories`.
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
 *
 * Note: extraction uses the in-memory transcript (it does NOT read the
 * `messages` table), so the two stages are genuinely independent — you can
 * run `extract` without having run `messages`.
 */

import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../../src/db/client.js";
import { messages as messagesTable, type NewMessage } from "@aura/db/schema";
import { toDbChannelType } from "../../src/memory/store.js";
import { embedTexts } from "../../src/lib/embeddings.js";
import {
  extractMemoriesFromTranscript,
  type ExtractionContext,
} from "../../src/memory/extract.js";
import type { ThreadMessage } from "../../src/memory/store.js";
import { logger } from "../../src/lib/logger.js";
import type { BenchCase } from "./types.js";

/** Max texts per embedding API call. */
const EMBED_CHUNK = 128;
/** Max rows per bulk INSERT. */
const INSERT_CHUNK = 100;
/**
 * Thread-context window for per-exchange replay, matching production's
 * `fetchThreadMessages({ limit: 30 })` default.
 */
const THREAD_WINDOW = 30;

export type ReplayMode = "session" | "exchange";

/**
 * Stable identity for the conversation a case carries, used to de-dupe
 * ingestion. Derived from the source + the full session payload so that
 * cases sharing one conversation (LoCoMo's many qa pairs) collapse, while
 * cases that merely reuse session-id labels (toy "S1", LoCoMo "D1" across
 * conversations) stay distinct.
 */
function conversationKey(benchCase: BenchCase): string {
  return createHash("sha1")
    .update(benchCase.source)
    .update("\0")
    .update(JSON.stringify(benchCase.sessions))
    .digest("hex");
}

/**
 * Synthetic per-bench Slack user id for a corpus speaker. Deterministic so
 * thread participants stay stable across runs.
 */
function speakerToUserId(caseId: string, speaker: string | undefined): string {
  if (!speaker) return `bench:${caseId}:user`;
  const slug = speaker.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `bench:${caseId}:${slug || "user"}`;
}

/** Number of unique conversations in a case list (for progress totals). */
export function countUniqueConversations(cases: BenchCase[]): number {
  return uniqueConversations(cases).length;
}

/**
 * Total number of sessions across the unique conversations in a case list.
 * Used as the `extract` progress total so the bar advances per session (the
 * real unit of extraction work) rather than per whole conversation.
 */
export function countTotalSessions(cases: BenchCase[]): number {
  return uniqueConversations(cases).reduce(
    (sum, c) => sum + c.sessions.length,
    0,
  );
}

/** De-dupe cases down to unique conversations (see conversationKey). */
export function uniqueConversations(cases: BenchCase[]): BenchCase[] {
  const seen = new Set<string>();
  const unique: BenchCase[] = [];
  for (const c of cases) {
    const key = conversationKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  return unique;
}

/** Run `worker` over `[0, count)` with at most `concurrency` in flight. */
async function pool(
  count: number,
  concurrency: number,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const run = async () => {
    while (true) {
      const i = idx++;
      if (i >= count) return;
      await worker(i);
    }
  };
  const n = Math.max(1, Math.min(concurrency, count));
  await Promise.all(Array.from({ length: n }, () => run()));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Stage 1: message storage ─────────────────────────────────────────────────

/** Build the `messages` rows (sans embedding) for one conversation. */
function buildMessageRows(benchCase: BenchCase, workspaceId: string): NewMessage[] {
  const channelId = `bench:${benchCase.id}`;
  const rows: NewMessage[] = [];

  for (const session of benchCase.sessions) {
    const threadTs = session.id;
    const sessionDate = new Date(session.timestamp);
    for (const [turnIdx, turn] of session.turns.entries()) {
      const userId = speakerToUserId(benchCase.id, turn.speaker);
      const turnTs = new Date(sessionDate.getTime() + turnIdx * 60_000);
      const diaId = turn.diaId ?? `${session.id}:${turnIdx + 1}`;
      rows.push({
        externalId: `${channelId}:${session.id}:${diaId}`,
        workspaceId,
        // slackTs encodes the session epoch so messages inside one session
        // sort together; bench workspaces don't interop with real Slack ts.
        slackTs: `${Math.floor(turnTs.getTime() / 1000)}.${String(turnIdx).padStart(6, "0")}`,
        slackThreadTs: threadTs,
        channelId,
        channelType: toDbChannelType("public_channel"),
        userId,
        role: turn.role,
        content: turn.content,
        createdAt: turnTs,
      } as NewMessage);
    }
  }
  return rows;
}

/**
 * Store + embed the raw messages for a list of cases. Embeddings are batched
 * (one `embedMany` call per chunk) and rows are bulk-inserted, which is far
 * faster than the per-message embed+insert production path.
 *
 * Functionally optional for scoring — retrieval and extraction never read the
 * `messages` table — but kept as a first-class stage for realism and so a run
 * can mirror production's stored corpus when desired.
 */
export async function storeMessagesForCases(
  cases: BenchCase[],
  workspaceId: string,
  concurrency = 4,
  onProgress?: (done: number, total: number) => void,
  embedMessages = true,
): Promise<{ totalMessages: number }> {
  const unique = uniqueConversations(cases);
  logger.debug(
    `bench: storing messages for ${unique.length} unique conversation(s) from ${cases.length} case(s)`,
    { workspaceId, concurrency, embedMessages },
  );

  let totalMessages = 0;
  let done = 0;

  await pool(unique.length, concurrency, async (i) => {
    const rows = buildMessageRows(unique[i], workspaceId);
    const withContent = rows.filter((r) => r.content && r.content.trim().length > 0);

    const embeddings = new Map<string, number[]>();
    if (embedMessages) {
      // Batch-embed in chunks, then attach embeddings positionally.
      for (const group of chunk(withContent, EMBED_CHUNK)) {
        try {
          const vecs = await embedTexts(group.map((r) => r.content as string));
          group.forEach((r, gi) => embeddings.set(r.externalId, vecs[gi]));
        } catch (error) {
          logger.warn("bench: message embedding chunk failed (storing without)", {
            error: String(error).slice(0, 200),
          });
        }
      }
    }

    const valued = rows.map((r) => ({
      ...r,
      embedding: embeddings.get(r.externalId) ?? null,
    }));
    for (const group of chunk(valued, INSERT_CHUNK)) {
      try {
        await db
          .insert(messagesTable)
          .values(group)
          .onConflictDoNothing({
            target: [messagesTable.workspaceId, messagesTable.externalId],
          });
        totalMessages += group.length;
      } catch (error) {
        logger.warn("bench: message bulk insert failed (continuing)", {
          error: String(error).slice(0, 200),
        });
      }
    }

    done += 1;
    onProgress?.(done, unique.length);
  });

  return { totalMessages };
}

// ── Stage 2: memory extraction ───────────────────────────────────────────────

/** One materialized turn of a session, with the metadata extraction needs. */
interface BuiltTurn {
  role: "user" | "assistant";
  userId: string;
  /** Human display name for this speaker (e.g. "James"), for the transcript. */
  speaker: string;
  content: string;
  createdAt: Date;
  diaId: string;
}

/** Materialize a session's turns with synthetic user ids and timestamps. */
function buildSessionTurns(benchCase: BenchCase, session: BenchCase["sessions"][number]): BuiltTurn[] {
  const sessionDate = new Date(session.timestamp);
  return session.turns.map((turn, turnIdx) => ({
    role: turn.role,
    userId: speakerToUserId(benchCase.id, turn.speaker),
    speaker: turn.speaker?.trim() || (turn.role === "assistant" ? "Assistant" : "User"),
    content: turn.content,
    // Per-turn timestamp inside the session window so retrieval ordering is
    // well-defined for temporal categories.
    createdAt: new Date(sessionDate.getTime() + turnIdx * 60_000),
    diaId: turn.diaId ?? `${session.id}:${turnIdx + 1}`,
  }));
}

/**
 * Build the synthetic name→id directory for one conversation. Maps every alias
 * a speaker might appear as (clean name, underscored, the raw synthetic id, and
 * the prefix-stripped display form fed to the LLM) to that speaker's synthetic
 * user id. Passed as ExtractionContext.userDirectory so the extractor resolves
 * fictional speakers against THIS map instead of the real Slack workspace.
 */
function buildUserDirectory(benchCase: BenchCase): Record<string, string> {
  const dir: Record<string, string> = {};
  const add = (key: string | undefined, id: string) => {
    const k = key?.toLowerCase().trim();
    if (k) dir[k] = id;
  };
  for (const session of benchCase.sessions) {
    for (const turn of session.turns) {
      const id = speakerToUserId(benchCase.id, turn.speaker);
      const name = turn.speaker?.trim();
      add(name, id);
      add(name?.replace(/\s+/g, "_"), id);
      add(id, id); // raw synthetic id resolves to itself (no warning)
      add(id.replace(/^bench:/, ""), id); // the display form
    }
  }
  return dir;
}

/** A single extraction call: the transcript window + its focal exchange. */
interface ExtractionCall {
  window: BuiltTurn[];
  focalAssistant: BuiltTurn | null;
  /** Corpus timestamp of this extraction event (assistant reply or session). */
  at: Date;
}

/**
 * Build the ordered extraction calls for one session under the given cadence.
 *  - "exchange": one call per assistant reply over the sliding THREAD_WINDOW,
 *    mirroring prod's per-reply incremental reconciliation. A session with no
 *    assistant turn falls back to a single full-transcript pass.
 *  - "session": a single pass over the whole session transcript.
 */
function buildSessionCalls(
  built: BuiltTurn[],
  sessionDate: Date,
  replay: ReplayMode,
): ExtractionCall[] {
  const calls: ExtractionCall[] = [];
  if (replay === "exchange") {
    for (let k = 0; k < built.length; k++) {
      if (built[k].role !== "assistant") continue;
      const window = built.slice(Math.max(0, k + 1 - THREAD_WINDOW), k + 1);
      calls.push({ window, focalAssistant: built[k], at: built[k].createdAt });
    }
    if (calls.length === 0) {
      calls.push({ window: built, focalAssistant: null, at: sessionDate });
    }
  } else {
    calls.push({ window: built, focalAssistant: null, at: sessionDate });
  }
  return calls;
}

/**
 * Execute one extraction call against the real reconciliation pipeline. Builds
 * the ExtractionContext exactly as production would and stamps corpus time
 * (`call.at`) onto every created/superseded/archived memory so bi-temporal
 * as-of retrieval can reconstruct the memory state at any point on the
 * timeline. Throws propagate to the caller for logging.
 */
async function runExtractionCall(
  benchCase: BenchCase,
  session: BenchCase["sessions"][number],
  call: ExtractionCall,
  workspaceId: string,
  extractionModelId: string,
  userDirectory: Record<string, string>,
  onUsage?: ExtractionContext["onUsage"],
): Promise<void> {
  const channelId = `bench:${benchCase.id}`;
  const threadTs = session.id;
  const threadMessages: ThreadMessage[] = call.window.map((b) => ({
    role: b.role,
    userId: b.userId,
    content: b.content,
    createdAt: b.createdAt,
  }));
  const lastUser =
    [...call.window].reverse().find((m) => m.role === "user") ?? call.window[call.window.length - 1];
  const lastAssistant =
    call.focalAssistant ?? [...call.window].reverse().find((m) => m.role === "assistant") ?? null;

  const ctx: ExtractionContext = {
    userMessage: lastUser.content,
    assistantResponse: lastAssistant?.content ?? "",
    userId: lastUser.userId,
    channelType: "public_channel",
    channelId,
    threadTs,
    workspaceId,
    extractionModelId,
    onUsage,
    triggerRole: "user",
    // valid_from / superseded_at / valid_until all stamp this corpus instant.
    createdAt: call.at,
    // Clean speaker name for the transcript; synthetic directory so user
    // references resolve locally instead of against the real Slack workspace.
    displayName: lastUser.speaker,
    userDirectory,
    benchProvenance: {
      datasetId: benchCase.source,
      caseId: benchCase.id,
      conversationId: benchCase.id,
      sessionId: session.id,
      sessionIds: [session.id],
      // Provenance reflects exactly the turns this extraction saw.
      diaIds: call.window.map((b) => b.diaId),
    },
  };

  await extractMemoriesFromTranscript(threadMessages, ctx);
}

/** One schedulable extraction event, with the corpus time it occurs at. */
export interface ExtractionUnit {
  /** Corpus timestamp of this extraction event — drives the global watermark. */
  at: Date;
  /** Run this single reconciliation pass. */
  run: () => Promise<void>;
}

/**
 * Build the full ordered list of extraction units for one conversation, across
 * all of its sessions, under the given cadence.
 *
 * Units MUST be run in array order: a later session/reply can supersede
 * memories created by an earlier one. The timeline producer enforces in-order
 * execution within a conversation while running distinct conversations
 * concurrently. Each unit carries its corpus timestamp so the engine can
 * advance the global extraction watermark per completed unit.
 */
export function buildExtractionUnits(
  benchCase: BenchCase,
  workspaceId: string,
  extractionModelId: string,
  replay: ReplayMode = "exchange",
  onUsage?: ExtractionContext["onUsage"],
): ExtractionUnit[] {
  const userDirectory = buildUserDirectory(benchCase);
  const units: ExtractionUnit[] = [];
  for (const session of benchCase.sessions) {
    const sessionDate = new Date(session.timestamp);
    const built = buildSessionTurns(benchCase, session);
    if (built.length === 0) continue;
    for (const call of buildSessionCalls(built, sessionDate, replay)) {
      units.push({
        at: call.at,
        run: () =>
          runExtractionCall(
            benchCase,
            session,
            call,
            workspaceId,
            extractionModelId,
            userDirectory,
            onUsage,
          ),
      });
    }
  }
  return units;
}

/**
 * Extract memories from one BenchCase serially (legacy, non-timeline path).
 * Kept for callers that want a simple per-conversation extraction without the
 * global watermark. Sessions and replies run in order; ticks `onSession` per
 * session (the unit `countTotalSessions` reports).
 */
export async function extractMemoriesForCase(
  benchCase: BenchCase,
  workspaceId: string,
  extractionModelId: string,
  replay: ReplayMode = "exchange",
  onSession?: () => void,
  onUsage?: ExtractionContext["onUsage"],
): Promise<{ memoriesAdded: number; sessionsIngested: number; extractions: number }> {
  const userDirectory = buildUserDirectory(benchCase);
  let sessionsIngested = 0;
  let extractions = 0;

  const beforeRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM memories WHERE workspace_id = ${workspaceId}
  `)) as any;
  const before = Number((beforeRows.rows ?? beforeRows)[0]?.n ?? 0);

  for (const session of benchCase.sessions) {
    const sessionDate = new Date(session.timestamp);
    const built = buildSessionTurns(benchCase, session);
    if (built.length === 0) {
      onSession?.();
      continue;
    }

    let sessionExtracted = false;
    for (const call of buildSessionCalls(built, sessionDate, replay)) {
      try {
        await runExtractionCall(
          benchCase,
          session,
          call,
          workspaceId,
          extractionModelId,
          userDirectory,
          onUsage,
        );
        extractions++;
        sessionExtracted = true;
      } catch (error) {
        logger.warn("bench: extraction failed", {
          caseId: benchCase.id,
          sessionId: session.id,
          replay,
          error: String(error).slice(0, 200),
        });
      }
    }
    if (sessionExtracted) sessionsIngested++;
    onSession?.();
  }

  const afterRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM memories WHERE workspace_id = ${workspaceId}
  `)) as any;
  const after = Number((afterRows.rows ?? afterRows)[0]?.n ?? 0);

  return { memoriesAdded: Math.max(0, after - before), sessionsIngested, extractions };
}

/**
 * Extract memories for a list of cases. De-dupes by conversation (LoCoMo packs
 * many QA pairs per conversation), then runs conversations through a bounded
 * worker pool — extraction is dominated by LLM latency, not DB throughput.
 *
 * Sessions within a conversation stay serial (supersession ordering); only
 * distinct conversations run concurrently.
 */
export async function extractMemoriesForCases(
  cases: BenchCase[],
  workspaceId: string,
  extractionModelId: string,
  concurrency = 4,
  onProgress?: (done: number, total: number) => void,
  replay: ReplayMode = "exchange",
  onUsage?: ExtractionContext["onUsage"],
): Promise<{ totalMemories: number; totalSessions: number; totalExtractions: number }> {
  const unique = uniqueConversations(cases);
  // Progress is reported per SESSION (the real unit of extraction work), so the
  // bar advances smoothly instead of jumping per whole conversation.
  const totalSessionUnits = unique.reduce((s, c) => s + c.sessions.length, 0);
  logger.debug(
    `bench: extracting memories from ${unique.length} unique conversation(s) of ${cases.length} case(s)`,
    { workspaceId, concurrency, replay, sessions: totalSessionUnits },
  );

  let totalMemories = 0;
  let totalSessions = 0;
  let totalExtractions = 0;
  let sessionsDone = 0;

  await pool(unique.length, concurrency, async (i) => {
    const r = await extractMemoriesForCase(
      unique[i],
      workspaceId,
      extractionModelId,
      replay,
      () => {
        sessionsDone += 1;
        onProgress?.(sessionsDone, totalSessionUnits);
      },
      onUsage,
    );
    totalMemories += r.memoriesAdded;
    totalSessions += r.sessionsIngested;
    totalExtractions += r.extractions;
  });

  return { totalMemories, totalSessions, totalExtractions };
}

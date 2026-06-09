/**
 * Eval funnel orchestration: score every unscored assistant response once.
 *
 * Idempotent + resumable: a response is "scored" the moment an
 * `eval_response_scores` row exists for its message_id (unique per workspace).
 * The walk moves FORWARD from the corpus start (March 12) by always picking the
 * earliest trace that still has an unscored response. Re-running never
 * re-scores — re-scoring happens only on a harness change or explicit human
 * request, never on dashboard load.
 *
 * Cost discipline: cheap Sonnet judge over ~20-turn windows, async/overnight.
 * Each invocation is bounded by a window budget + wall-clock budget so it fits
 * a single serverless execution; the next run continues where this left off.
 */

import { sql, eq, asc, and } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  conversationMessages,
  conversationParts,
  conversationTraces,
  evalResponseScores,
  type NewEvalResponseScore,
} from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { buildWindows } from "./window.js";
import { judgeWindow } from "./judge.js";
import { EVAL_CORPUS_START, type ConversationTurn } from "./types.js";

const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || "default";

export interface ScoreRunOptions {
  workspaceId?: string;
  /** Max windows to judge this invocation (cost/time ceiling). */
  maxWindows?: number;
  /** Max distinct threads to process this invocation. */
  maxThreads?: number;
  /** Wall-clock budget in ms; stop starting new work past it. */
  budgetMs?: number;
  /** Corpus start ISO timestamp (walk forward from here). */
  corpusStart?: string;
}

export interface ScoreRunResult {
  threadsProcessed: number;
  windowsJudged: number;
  responsesScored: number;
  done: boolean;
  judgeModel: string | null;
}

interface ThreadUnit {
  key: string;
  channelId: string | null;
  threadTs: string | null;
  traceId: string;
}

/**
 * Find the next thread-units (walking forward from corpus start) that still
 * contain an unscored assistant-text response. A unit is a whole Slack thread
 * (channelId + threadTs); job-execution / null-thread traces are their own unit.
 */
async function findUnscoredUnits(
  workspaceId: string,
  corpusStart: string,
  limit: number,
): Promise<ThreadUnit[]> {
  const rows = await db.execute<{
    id: string;
    channel_id: string | null;
    thread_ts: string | null;
  }>(sql`
    SELECT ct.id, ct.channel_id, ct.thread_ts
    FROM ${conversationTraces} ct
    WHERE ct.workspace_id = ${workspaceId}
      AND ct.created_at >= ${corpusStart}
      AND EXISTS (
        SELECT 1 FROM ${conversationMessages} cm
        JOIN ${conversationParts} cp ON cp.message_id = cm.id
        WHERE cm.conversation_id = ct.id
          AND cm.role = 'assistant'
          AND cp.type = 'text'
          AND cp.text_value IS NOT NULL
          AND length(trim(cp.text_value)) > 0
          AND NOT EXISTS (
            SELECT 1 FROM ${evalResponseScores} e
            WHERE e.message_id = cm.id AND e.workspace_id = ct.workspace_id
          )
      )
    ORDER BY ct.created_at ASC
    LIMIT ${limit}
  `);

  const seen = new Set<string>();
  const units: ThreadUnit[] = [];
  for (const r of rows.rows ?? (rows as any)) {
    const threadTs = r.thread_ts;
    const channelId = r.channel_id;
    const key = threadTs && channelId ? `${channelId}::${threadTs}` : `trace::${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    units.push({ key, channelId, threadTs, traceId: r.id });
  }
  return units;
}

/** Load every turn of a thread-unit in chronological order across its traces. */
async function loadUnitTurns(
  workspaceId: string,
  unit: ThreadUnit,
): Promise<ConversationTurn[]> {
  const traceWhere =
    unit.threadTs && unit.channelId
      ? and(
          eq(conversationTraces.workspaceId, workspaceId),
          eq(conversationTraces.channelId, unit.channelId),
          eq(conversationTraces.threadTs, unit.threadTs),
        )
      : eq(conversationTraces.id, unit.traceId);

  const traces = await db
    .select({
      id: conversationTraces.id,
      threadTs: conversationTraces.threadTs,
      createdAt: conversationTraces.createdAt,
    })
    .from(conversationTraces)
    .where(traceWhere)
    .orderBy(asc(conversationTraces.createdAt));

  if (traces.length === 0) return [];
  const traceIds = traces.map((t) => t.id);
  const traceOrder = new Map(traceIds.map((id, i) => [id, i]));
  const threadTsByTrace = new Map(traces.map((t) => [t.id, t.threadTs]));

  const msgs = await db
    .select()
    .from(conversationMessages)
    .where(sql`${conversationMessages.conversationId} IN ${traceIds}`)
    .orderBy(asc(conversationMessages.orderIndex));

  const msgIds = msgs.map((m) => m.id);
  const parts =
    msgIds.length > 0
      ? await db
          .select()
          .from(conversationParts)
          .where(sql`${conversationParts.messageId} IN ${msgIds}`)
          .orderBy(asc(conversationParts.orderIndex))
      : [];

  const scoredRows =
    msgIds.length > 0
      ? await db
          .select({ messageId: evalResponseScores.messageId })
          .from(evalResponseScores)
          .where(
            and(
              eq(evalResponseScores.workspaceId, workspaceId),
              sql`${evalResponseScores.messageId} IN ${msgIds}`,
            ),
          )
      : [];
  const scored = new Set(scoredRows.map((r) => r.messageId));

  const partsByMsg = new Map<string, typeof parts>();
  for (const p of parts) {
    const list = partsByMsg.get(p.messageId) ?? [];
    list.push(p);
    partsByMsg.set(p.messageId, list);
  }

  // Sort messages by (trace chronological order, then order_index within trace).
  const ordered = [...msgs].sort((a, b) => {
    const ta = traceOrder.get(a.conversationId) ?? 0;
    const tb = traceOrder.get(b.conversationId) ?? 0;
    if (ta !== tb) return ta - tb;
    return a.orderIndex - b.orderIndex;
  });

  const turns: ConversationTurn[] = [];
  for (const m of ordered) {
    if (m.role === "system") continue; // huge prompt, not needed for intent judging
    const mParts = partsByMsg.get(m.id) ?? [];

    const textParts = mParts.filter(
      (p) => p.type === "text" && p.textValue && p.textValue.trim().length > 0,
    );
    const toolParts = mParts.filter((p) => p.type === "tool-invocation");

    const text =
      textParts.map((p) => p.textValue).join("\n\n") || (m.content ?? "");
    const textPartId =
      m.role === "assistant" && textParts.length > 0 ? textParts[0].id : null;
    const toolSummary =
      toolParts.length > 0
        ? toolParts.map((p) => p.toolName ?? "tool").join(", ")
        : null;

    turns.push({
      messageId: m.id,
      role: m.role,
      textPartId,
      text,
      toolSummary,
      traceId: m.conversationId,
      threadTs: threadTsByTrace.get(m.conversationId) ?? null,
      alreadyScored: scored.has(m.id),
      createdAt: m.createdAt,
    });
  }
  return turns;
}

/** Index turns by their text part id for fast verdict → row mapping. */
function indexByPartId(turns: ConversationTurn[]): Map<string, ConversationTurn> {
  const map = new Map<string, ConversationTurn>();
  for (const t of turns) if (t.textPartId) map.set(t.textPartId, t);
  return map;
}

export async function scoreUnscoredResponses(
  opts: ScoreRunOptions = {},
): Promise<ScoreRunResult> {
  const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const maxWindows = opts.maxWindows ?? 40;
  const maxThreads = opts.maxThreads ?? 25;
  const budgetMs = opts.budgetMs ?? 700_000;
  const corpusStart = opts.corpusStart ?? EVAL_CORPUS_START;
  const startedAt = Date.now();

  const result: ScoreRunResult = {
    threadsProcessed: 0,
    windowsJudged: 0,
    responsesScored: 0,
    done: false,
    judgeModel: null,
  };

  // Pull a generous batch of candidate traces; many collapse into shared threads.
  const units = await findUnscoredUnits(workspaceId, corpusStart, maxThreads * 4);
  if (units.length === 0) {
    result.done = true;
    return result;
  }

  for (const unit of units) {
    if (result.threadsProcessed >= maxThreads) break;
    if (result.windowsJudged >= maxWindows) break;
    if (Date.now() - startedAt > budgetMs) break;

    const turns = await loadUnitTurns(workspaceId, unit);
    if (turns.length === 0) continue;

    const byPartId = indexByPartId(turns);
    const windows = buildWindows(turns);
    if (windows.length === 0) continue;

    result.threadsProcessed++;

    for (const window of windows) {
      if (result.windowsJudged >= maxWindows) break;
      if (Date.now() - startedAt > budgetMs) break;

      let judged;
      try {
        judged = await judgeWindow(window);
      } catch (err) {
        logger.error("eval judge: window failed (non-fatal, will retry next run)", {
          error: err instanceof Error ? err.message : String(err),
          owned: window.ownedPartIds.length,
        });
        continue;
      }
      result.windowsJudged++;
      result.judgeModel = judged.modelId;

      const inserts: NewEvalResponseScore[] = [];
      for (const partId of window.ownedPartIds) {
        const turn = byPartId.get(partId);
        if (!turn) continue;
        const v = judged.byPartId.get(partId);

        inserts.push({
          workspaceId,
          messageId: turn.messageId,
          partId,
          traceId: turn.traceId,
          threadTs: turn.threadTs,
          // When the judge omitted a verdict for a marked response, store a
          // non-scorable placeholder so the response is not re-judged forever.
          scorable: v?.scorable ?? false,
          verdict: v && v.scorable ? v.verdict ?? null : null,
          servingIntent: v?.serving_intent ?? null,
          resolvedInWindow: v?.resolved_in_window ?? null,
          failureClass: v?.failure_class ?? "none",
          note: v?.note ?? "Judge returned no verdict for this response.",
          judgeModel: judged.modelId,
        });
      }

      if (inserts.length > 0) {
        await db
          .insert(evalResponseScores)
          .values(inserts)
          .onConflictDoNothing({
            target: [evalResponseScores.workspaceId, evalResponseScores.messageId],
          });
        result.responsesScored += inserts.length;
      }
    }
  }

  // "done" only when this invocation exhausted the backlog within its budget.
  const remaining = await findUnscoredUnits(workspaceId, corpusStart, 1);
  result.done = remaining.length === 0;
  return result;
}

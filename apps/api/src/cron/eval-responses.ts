/**
 * Overnight eval batch (Machine A of the eval funnel).
 *
 * Walks forward from the start of the conversation corpus and scores every
 * not-yet-scored assistant response exactly once: thread → turns → 20-turn
 * sliding windows → one fast-tier judge call per window → one
 * eval_response_scores row per response, mapped by echoed part_id.
 *
 * Idempotent: a unique (workspace_id, message_id) index + onConflictDoNothing
 * means re-runs never duplicate or overwrite verdicts. Re-scoring happens only
 * via explicit human/harness action (delete the rows), never on read.
 */
import { Hono } from "hono";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  conversationMessages,
  conversationParts,
  conversationTraces,
  evalResponseScores,
  type NewEvalResponseScore,
} from "@aura/db/schema";
import { db } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { judgeWindow } from "../eval/judge.js";
import { buildTurns, buildWindows, type EvalTurn } from "../eval/windowing.js";

export const evalResponsesApp = new Hono();

/** Max thread groups processed per nightly invocation. */
const DEFAULT_MAX_GROUPS = 40;
/** Soft wall-clock budget; Vercel maxDuration is 800s, leave headroom. */
const TIME_BUDGET_MS = 11 * 60_000;
/** Don't judge threads that were active in the last 30 minutes — a turn that
 * just hedged may resolve in a moment; let the thread settle first. */
const SETTLE_MS = 30 * 60_000;

interface UnscoredGroup {
  channelId: string | null;
  threadTs: string | null;
  soleTraceId: string;
  firstAt: Date;
}

/**
 * Find thread groups (channel_id + thread_ts, or the bare trace for
 * thread-less invocations like job executions) that still contain unscored
 * assistant responses, oldest first — the forward walk from corpus start.
 */
export async function findUnscoredGroups(limit: number): Promise<UnscoredGroup[]> {
  const groupKey = sql<string>`coalesce(${conversationTraces.channelId}, '') || '::' || coalesce(${conversationTraces.threadTs}, ${conversationTraces.id}::text)`;
  const settledBefore = new Date(Date.now() - SETTLE_MS);

  const rows = await db
    .select({
      channelId: sql<string | null>`(array_agg(${conversationTraces.channelId}))[1]`,
      threadTs: sql<string | null>`(array_agg(${conversationTraces.threadTs}))[1]`,
      soleTraceId: sql<string>`(array_agg(${conversationTraces.id}::text))[1]`,
      firstAt: sql<string>`min(${conversationTraces.createdAt})`,
    })
    .from(conversationParts)
    .innerJoin(
      conversationMessages,
      eq(conversationParts.messageId, conversationMessages.id),
    )
    .innerJoin(
      conversationTraces,
      eq(conversationMessages.conversationId, conversationTraces.id),
    )
    .leftJoin(
      evalResponseScores,
      eq(evalResponseScores.messageId, conversationMessages.id),
    )
    .where(
      and(
        eq(conversationMessages.role, "assistant"),
        eq(conversationParts.type, "text"),
        sql`length(trim(coalesce(${conversationParts.textValue}, ''))) > 0`,
        isNull(evalResponseScores.id),
      ),
    )
    .groupBy(groupKey)
    .having(sql`max(${conversationMessages.createdAt}) < ${settledBefore.toISOString()}`)
    .orderBy(sql`min(${conversationTraces.createdAt}) asc`)
    .limit(limit);

  return rows.map((row) => ({
    channelId: row.channelId,
    threadTs: row.threadTs,
    soleTraceId: row.soleTraceId,
    firstAt: new Date(row.firstAt),
  }));
}

interface GroupResult {
  windowsJudged: number;
  responsesScored: number;
  omitted: number;
}

/** Judge every unscored assistant response in one thread group. */
export async function scoreGroup(
  group: UnscoredGroup,
  deadline: number,
): Promise<GroupResult> {
  const traces = group.threadTs
    ? await db
        .select()
        .from(conversationTraces)
        .where(
          and(
            sql`coalesce(${conversationTraces.channelId}, '') = ${group.channelId ?? ""}`,
            eq(conversationTraces.threadTs, group.threadTs),
          ),
        )
        .orderBy(asc(conversationTraces.createdAt))
    : await db
        .select()
        .from(conversationTraces)
        .where(eq(conversationTraces.id, group.soleTraceId));

  if (traces.length === 0) return { windowsJudged: 0, responsesScored: 0, omitted: 0 };
  const traceById = new Map(traces.map((t) => [t.id, t]));
  const traceIds = traces.map((t) => t.id);

  const messages = await db
    .select()
    .from(conversationMessages)
    .where(
      and(
        inArray(conversationMessages.conversationId, traceIds),
        inArray(conversationMessages.role, ["user", "assistant"]),
      ),
    )
    .orderBy(asc(conversationMessages.orderIndex));

  const messageIds = messages.map((m) => m.id);
  if (messageIds.length === 0) return { windowsJudged: 0, responsesScored: 0, omitted: 0 };

  const parts = await db
    .select({
      id: conversationParts.id,
      messageId: conversationParts.messageId,
      type: conversationParts.type,
      orderIndex: conversationParts.orderIndex,
      textValue: conversationParts.textValue,
      toolName: conversationParts.toolName,
    })
    .from(conversationParts)
    .where(
      and(
        inArray(conversationParts.messageId, messageIds),
        inArray(conversationParts.type, ["text", "tool-invocation"]),
      ),
    )
    .orderBy(asc(conversationParts.orderIndex));

  const scoredRows = await db
    .select({ messageId: evalResponseScores.messageId })
    .from(evalResponseScores)
    .where(inArray(evalResponseScores.messageId, messageIds));
  const scoredMessageIds = new Set(scoredRows.map((r) => r.messageId));

  const turns = buildTurns(traces, messages, parts);
  const turnByPartId = new Map<string, EvalTurn>(
    turns.filter((t) => t.partId).map((t) => [t.partId!, t]),
  );

  const sessionId = group.threadTs
    ? `${group.channelId ?? ""}::${group.threadTs}`
    : group.soleTraceId;

  const result: GroupResult = { windowsJudged: 0, responsesScored: 0, omitted: 0 };

  for (const window of buildWindows(turns)) {
    // Only score responses that don't already own a verdict; previously
    // scored turns stay in the transcript as context only.
    const unscoredOwned = window.ownedPartIds.filter((partId) => {
      const turn = turnByPartId.get(partId);
      return turn && !scoredMessageIds.has(turn.messageId);
    });
    if (unscoredOwned.length === 0) continue;
    if (Date.now() > deadline) break;

    const { judged, judgeModel, omittedIds } = await judgeWindow(
      { turns: window.turns, ownedPartIds: unscoredOwned },
      { sessionId },
    );

    const rows: NewEvalResponseScore[] = [];
    for (const [partId, verdict] of judged) {
      const turn = turnByPartId.get(partId);
      if (!turn) continue;
      const trace = traceById.get(turn.traceId);
      rows.push({
        workspaceId: trace?.workspaceId ?? "default",
        messageId: turn.messageId,
        partId,
        traceId: turn.traceId,
        threadTs: trace?.threadTs ?? null,
        servingIntent: verdict.servingIntent,
        resolvedInWindow: verdict.resolvedInWindow,
        verdict: verdict.verdict,
        scorable: verdict.scorable,
        failureClass: verdict.failureClass,
        note: verdict.note,
        judgeModel,
      });
    }

    if (rows.length > 0) {
      await db.insert(evalResponseScores).values(rows).onConflictDoNothing();
      for (const row of rows) scoredMessageIds.add(row.messageId);
    }

    result.windowsJudged += 1;
    result.responsesScored += rows.length;
    result.omitted += omittedIds.length;
  }

  return result;
}

/**
 * Vercel Cron handler for the overnight eval batch.
 * Runs daily at 2:00 AM UTC (configured in vercel.json).
 * Protected by CRON_SECRET. Optional `?limit=` caps thread groups per run.
 */
evalResponsesApp.get("/api/cron/eval-responses", async (c) => {
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("Unauthorized eval-responses cron invocation");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const limitParam = parseInt(c.req.query("limit") || "", 10);
  const maxGroups =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, 200)
      : DEFAULT_MAX_GROUPS;

  const start = Date.now();
  const deadline = start + TIME_BUDGET_MS;

  try {
    const groups = await findUnscoredGroups(maxGroups);
    logger.info("Cron: eval-responses starting", { groups: groups.length, maxGroups });

    let groupsProcessed = 0;
    let windowsJudged = 0;
    let responsesScored = 0;
    let omitted = 0;

    for (const group of groups) {
      if (Date.now() > deadline) break;
      try {
        const result = await scoreGroup(group, deadline);
        groupsProcessed += 1;
        windowsJudged += result.windowsJudged;
        responsesScored += result.responsesScored;
        omitted += result.omitted;
      } catch (error) {
        // One broken thread must not block the forward walk.
        logger.error("eval-responses: group failed", {
          channelId: group.channelId,
          threadTs: group.threadTs,
          soleTraceId: group.soleTraceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const duration = Date.now() - start;
    logger.info("Cron: eval-responses finished", {
      duration,
      groupsProcessed,
      windowsJudged,
      responsesScored,
      omitted,
    });

    return c.json({
      ok: true,
      duration,
      groupsFound: groups.length,
      groupsProcessed,
      windowsJudged,
      responsesScored,
      omitted,
    });
  } catch (error) {
    logger.error("Cron: eval-responses failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Eval responses batch failed" }, 500);
  }
});

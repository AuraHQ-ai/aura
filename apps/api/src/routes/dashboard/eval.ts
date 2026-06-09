import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  evalResponseScores,
  conversationTraces,
  conversationParts,
  users,
} from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, createDashboardApp } from "./schemas.js";

export const dashboardEvalApp = createDashboardApp();

const WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || "default";

// ── List scored responses (the value-leakage funnel rows) ───────────────────

const listScoresRoute = createRoute({
  method: "get",
  path: "/scores",
  tags: ["Eval"],
  summary: "List scored responses with filters",
  request: {
    query: z.object({
      verdict: z.string().optional(),
      failureClass: z.string().optional(),
      scorable: z.string().optional(),
      ratified: z.string().optional(),
      servingIntent: z.string().optional(),
      userId: z.string().optional(),
      search: z.string().optional(),
      page: z.coerce.number().optional(),
      limit: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ items: z.array(z.any()), total: z.number() }),
        },
      },
      description: "Success",
    },
    500: { content: { "application/json": { schema: errorSchema } }, description: "Error" },
  },
});

dashboardEvalApp.openapi(listScoresRoute, async (c) => {
  try {
    const q = c.req.query();
    const page = parseInt(q.page || "1", 10);
    const limit = Math.min(parseInt(q.limit || "25", 10), 100);
    const offset = (page - 1) * limit;

    const conditions: SQL[] = [eq(evalResponseScores.workspaceId, WORKSPACE_ID)];
    if (q.verdict && q.verdict !== "all") {
      conditions.push(eq(evalResponseScores.verdict, q.verdict as any));
    }
    if (q.failureClass && q.failureClass !== "all") {
      conditions.push(eq(evalResponseScores.failureClass, q.failureClass as any));
    }
    if (q.scorable === "true") conditions.push(eq(evalResponseScores.scorable, true));
    if (q.scorable === "false") conditions.push(eq(evalResponseScores.scorable, false));
    if (q.ratified === "true") conditions.push(sql`${evalResponseScores.ratifiedBy} IS NOT NULL`);
    if (q.ratified === "false") conditions.push(sql`${evalResponseScores.ratifiedBy} IS NULL`);
    if (q.servingIntent) {
      conditions.push(sql`${evalResponseScores.servingIntent} ILIKE ${"%" + q.servingIntent + "%"}`);
    }
    if (q.userId) conditions.push(eq(conversationTraces.userId, q.userId));
    if (q.search) {
      conditions.push(
        sql`(${evalResponseScores.note} ILIKE ${"%" + q.search + "%"} OR ${evalResponseScores.servingIntent} ILIKE ${"%" + q.search + "%"})`,
      );
    }
    const where = and(...conditions);

    const [{ value: total }] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(evalResponseScores)
      .leftJoin(conversationTraces, eq(evalResponseScores.traceId, conversationTraces.id))
      .where(where);

    const rows = await db
      .select({
        id: evalResponseScores.id,
        messageId: evalResponseScores.messageId,
        partId: evalResponseScores.partId,
        traceId: evalResponseScores.traceId,
        threadTs: evalResponseScores.threadTs,
        verdict: evalResponseScores.verdict,
        scorable: evalResponseScores.scorable,
        servingIntent: evalResponseScores.servingIntent,
        resolvedInWindow: evalResponseScores.resolvedInWindow,
        failureClass: evalResponseScores.failureClass,
        note: evalResponseScores.note,
        goldAnswer: evalResponseScores.goldAnswer,
        rubric: evalResponseScores.rubric,
        ratifiedBy: evalResponseScores.ratifiedBy,
        judgeModel: evalResponseScores.judgeModel,
        createdAt: evalResponseScores.createdAt,
        channelId: conversationTraces.channelId,
        userId: conversationTraces.userId,
        modelId: conversationTraces.resolvedModelId,
        costUsd: conversationTraces.costUsd,
        responseText: conversationParts.textValue,
      })
      .from(evalResponseScores)
      .leftJoin(conversationTraces, eq(evalResponseScores.traceId, conversationTraces.id))
      .leftJoin(conversationParts, eq(evalResponseScores.partId, conversationParts.id))
      .where(where)
      .orderBy(desc(evalResponseScores.createdAt))
      .limit(limit)
      .offset(offset);

    const userIds = [...new Set(rows.map((r) => r.userId).filter(Boolean))] as string[];
    let userNames: Record<string, string> = {};
    if (userIds.length > 0) {
      const profiles = await db
        .select({ slackUserId: users.slackUserId, displayName: users.displayName })
        .from(users)
        .where(sql`${users.slackUserId} IN ${userIds}`);
      userNames = Object.fromEntries(profiles.map((p) => [p.slackUserId, p.displayName]));
    }

    const items = rows.map((r) => ({
      ...r,
      resolvedName: r.userId ? userNames[r.userId] ?? null : null,
    }));

    return c.json({ items, total } as any, 200);
  } catch (error) {
    logger.error("Failed to list eval scores", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── Funnel aggregates (DERIVED views, never materialized) ────────────────────

const funnelRoute = createRoute({
  method: "get",
  path: "/funnel",
  tags: ["Eval"],
  summary: "Funnel aggregates by verdict / failure_class / serving_intent / user",
  responses: {
    200: { content: { "application/json": { schema: z.any() } }, description: "Success" },
    500: { content: { "application/json": { schema: errorSchema } }, description: "Error" },
  },
});

dashboardEvalApp.openapi(funnelRoute, async (c) => {
  try {
    const wsScored = and(
      eq(evalResponseScores.workspaceId, WORKSPACE_ID),
      eq(evalResponseScores.scorable, true),
    );

    const [byVerdict, byFailureClass, byIntent, byUser, totals] = await Promise.all([
      db
        .select({ verdict: evalResponseScores.verdict, count: sql<number>`count(*)::int` })
        .from(evalResponseScores)
        .where(wsScored)
        .groupBy(evalResponseScores.verdict),
      db
        .select({ failureClass: evalResponseScores.failureClass, count: sql<number>`count(*)::int` })
        .from(evalResponseScores)
        .where(and(wsScored, eq(evalResponseScores.verdict, "failed")))
        .groupBy(evalResponseScores.failureClass)
        .orderBy(desc(sql`count(*)`)),
      db
        .select({ servingIntent: evalResponseScores.servingIntent, count: sql<number>`count(*)::int` })
        .from(evalResponseScores)
        .where(and(wsScored, eq(evalResponseScores.verdict, "failed")))
        .groupBy(evalResponseScores.servingIntent)
        .orderBy(desc(sql`count(*)`))
        .limit(20),
      db
        .select({
          userId: conversationTraces.userId,
          failed: sql<number>`count(*) FILTER (WHERE ${evalResponseScores.verdict} = 'failed')::int`,
          total: sql<number>`count(*)::int`,
          costUsd: sql<number>`coalesce(sum(${conversationTraces.costUsd}::numeric), 0)::float`,
        })
        .from(evalResponseScores)
        .leftJoin(conversationTraces, eq(evalResponseScores.traceId, conversationTraces.id))
        .where(wsScored)
        .groupBy(conversationTraces.userId)
        .orderBy(desc(sql`count(*) FILTER (WHERE ${evalResponseScores.verdict} = 'failed')`))
        .limit(20),
      db
        .select({
          scorable: sql<number>`count(*) FILTER (WHERE ${evalResponseScores.scorable})::int`,
          total: sql<number>`count(*)::int`,
          ratifiedFailed: sql<number>`count(*) FILTER (WHERE ${evalResponseScores.verdict} = 'failed' AND ${evalResponseScores.ratifiedBy} IS NOT NULL)::int`,
        })
        .from(evalResponseScores)
        .where(eq(evalResponseScores.workspaceId, WORKSPACE_ID)),
    ]);

    const userIds = [...new Set(byUser.map((r) => r.userId).filter(Boolean))] as string[];
    let userNames: Record<string, string> = {};
    if (userIds.length > 0) {
      const profiles = await db
        .select({ slackUserId: users.slackUserId, displayName: users.displayName })
        .from(users)
        .where(sql`${users.slackUserId} IN ${userIds}`);
      userNames = Object.fromEntries(profiles.map((p) => [p.slackUserId, p.displayName]));
    }

    return c.json(
      {
        byVerdict,
        byFailureClass,
        byIntent,
        byUser: byUser.map((r) => ({
          ...r,
          resolvedName: r.userId ? userNames[r.userId] ?? null : null,
        })),
        totals: totals[0] ?? { scorable: 0, total: 0, ratifiedFailed: 0 },
      } as any,
      200,
    );
  } catch (error) {
    logger.error("Failed to build eval funnel", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── Scores for one trace (rendered next to the trace viewer) ─────────────────

const traceScoresRoute = createRoute({
  method: "get",
  path: "/trace/{traceId}",
  tags: ["Eval"],
  summary: "Get response scores for a conversation trace",
  request: {
    params: z.object({ traceId: z.string().openapi({ param: { name: "traceId", in: "path" } }) }),
  },
  responses: {
    200: { content: { "application/json": { schema: z.any() } }, description: "Success" },
    500: { content: { "application/json": { schema: errorSchema } }, description: "Error" },
  },
});

dashboardEvalApp.openapi(traceScoresRoute, async (c) => {
  try {
    const traceId = c.req.param("traceId");
    const rows = await db
      .select()
      .from(evalResponseScores)
      .where(
        and(
          eq(evalResponseScores.workspaceId, WORKSPACE_ID),
          eq(evalResponseScores.traceId, traceId),
        ),
      )
      .orderBy(asc(evalResponseScores.createdAt));
    return c.json({ items: rows } as any, 200);
  } catch (error) {
    logger.error("Failed to get trace eval scores", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── Adjudication: human comment / gold / rubric / ratify ─────────────────────

const updateScoreRoute = createRoute({
  method: "patch",
  path: "/scores/{id}",
  tags: ["Eval"],
  summary: "Adjudicate a response score (note / gold / rubric / ratify)",
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            note: z.string().nullable().optional(),
            goldAnswer: z.string().nullable().optional(),
            rubric: z
              .object({
                mustDo: z.array(z.string()).optional(),
                mustNotDo: z.array(z.string()).optional(),
              })
              .nullable()
              .optional(),
            verdict: z.enum(["fulfilled", "partial", "failed"]).nullable().optional(),
            failureClass: z
              .enum([
                "missing_cred",
                "bad_memory",
                "bad_harness",
                "missing_tool",
                "reasoning",
                "latency",
                "none",
              ])
              .optional(),
            ratifiedBy: z.string().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: z.any() } }, description: "Success" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
    500: { content: { "application/json": { schema: errorSchema } }, description: "Error" },
  },
});

dashboardEvalApp.openapi(updateScoreRoute, async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const update: Record<string, unknown> = {};
    if ("note" in body) update.note = body.note;
    if ("goldAnswer" in body) update.goldAnswer = body.goldAnswer;
    if ("rubric" in body) update.rubric = body.rubric;
    if ("verdict" in body) update.verdict = body.verdict;
    if ("failureClass" in body) update.failureClass = body.failureClass;
    if ("ratifiedBy" in body) update.ratifiedBy = body.ratifiedBy;

    if (Object.keys(update).length === 0) {
      return c.json({ error: "No fields to update" }, 500);
    }

    const [row] = await db
      .update(evalResponseScores)
      .set(update)
      .where(
        and(
          eq(evalResponseScores.id, id),
          eq(evalResponseScores.workspaceId, WORKSPACE_ID),
        ),
      )
      .returning();

    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row as any, 200);
  } catch (error) {
    logger.error("Failed to update eval score", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

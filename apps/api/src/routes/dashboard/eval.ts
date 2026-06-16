/**
 * Dashboard API for the eval response funnel (Machine A).
 *
 * - List/filter atomic response verdicts (the value-leakage funnel).
 * - Derived (never materialized) rollups: failure_class / serving_intent / user.
 * - Human adjudication: note, gold_answer, rubric, ratified_by on a SPECIFIC
 *   failed response.
 * - Bench-case candidates for the curated regression bench (#1106): ratified
 *   failed rows, deduped by failure_class.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  conversationTraces,
  evalResponseScores,
  evalFailureClasses,
  evalVerdicts,
  users,
} from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, createDashboardApp, idParamSchema } from "./schemas.js";

export const dashboardEvalApp = createDashboardApp();

const listResponseSchema = z.object({
  items: z.array(z.any()),
  total: z.number(),
});

// ── Funnel rollups (derived, never materialized) ────────────────────────────

const funnelRoute = createRoute({
  method: "get",
  path: "/funnel",
  tags: ["Eval"],
  summary: "Aggregate response scores by failure class, intent, and user",
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardEvalApp.openapi(funnelRoute, async (c) => {
  try {
    const [totals] = await db
      .select({
        total: sql<number>`count(*)::int`,
        scorable: sql<number>`count(*) filter (where ${evalResponseScores.scorable})::int`,
        fulfilled: sql<number>`count(*) filter (where ${evalResponseScores.verdict} = 'fulfilled')::int`,
        partial: sql<number>`count(*) filter (where ${evalResponseScores.verdict} = 'partial')::int`,
        failed: sql<number>`count(*) filter (where ${evalResponseScores.verdict} = 'failed')::int`,
        ratified: sql<number>`count(*) filter (where ${evalResponseScores.ratifiedBy} is not null)::int`,
      })
      .from(evalResponseScores);

    const byFailureClass = await db
      .select({
        failureClass: evalResponseScores.failureClass,
        count: sql<number>`count(*)::int`,
        costUsd: sql<number>`coalesce(sum(${conversationTraces.costUsd}::numeric), 0)::float`,
      })
      .from(evalResponseScores)
      .innerJoin(
        conversationTraces,
        eq(evalResponseScores.traceId, conversationTraces.id),
      )
      .where(
        sql`${evalResponseScores.verdict} IN ('failed', 'partial') AND ${evalResponseScores.failureClass} <> 'none'`,
      )
      .groupBy(evalResponseScores.failureClass)
      .orderBy(sql`count(*) desc`);

    const byIntent = await db
      .select({
        servingIntent: evalResponseScores.servingIntent,
        count: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where ${evalResponseScores.verdict} = 'failed')::int`,
      })
      .from(evalResponseScores)
      .where(
        sql`${evalResponseScores.servingIntent} IS NOT NULL AND ${evalResponseScores.scorable}`,
      )
      .groupBy(evalResponseScores.servingIntent)
      .orderBy(sql`count(*) filter (where ${evalResponseScores.verdict} = 'failed') desc, count(*) desc`)
      .limit(25);

    const byUser = await db
      .select({
        userId: conversationTraces.userId,
        count: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where ${evalResponseScores.verdict} = 'failed')::int`,
        costUsd: sql<number>`coalesce(sum(${conversationTraces.costUsd}::numeric), 0)::float`,
      })
      .from(evalResponseScores)
      .innerJoin(
        conversationTraces,
        eq(evalResponseScores.traceId, conversationTraces.id),
      )
      .where(
        sql`${conversationTraces.userId} IS NOT NULL AND ${evalResponseScores.scorable}`,
      )
      .groupBy(conversationTraces.userId)
      .orderBy(sql`count(*) filter (where ${evalResponseScores.verdict} = 'failed') desc, count(*) desc`)
      .limit(25);

    const userIds = byUser.map((r) => r.userId).filter(Boolean) as string[];
    let userNames: Record<string, string> = {};
    if (userIds.length > 0) {
      const profileRows = await db
        .select({ slackUserId: users.slackUserId, displayName: users.displayName })
        .from(users)
        .where(sql`${users.slackUserId} IN ${userIds}`);
      userNames = Object.fromEntries(
        profileRows.map((r) => [r.slackUserId, r.displayName]),
      );
    }

    return c.json(
      {
        totals,
        byFailureClass,
        byIntent,
        byUser: byUser.map((r) => ({
          ...r,
          resolvedName: r.userId ? userNames[r.userId] ?? null : null,
        })),
      } as any,
      200,
    );
  } catch (error) {
    logger.error("Failed to load eval funnel", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── Bench-case candidates (feeds the curated regression bench, #1106) ────────

const benchCandidatesRoute = createRoute({
  method: "get",
  path: "/bench-candidates",
  tags: ["Eval"],
  summary:
    "Ratified failed responses as bench-case candidates, deduped by failure class",
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardEvalApp.openapi(benchCandidatesRoute, async (c) => {
  try {
    // One representative (most recently ratified gold-bearing row preferred,
    // else newest) per failure class — curate ruthlessly, don't let "score
    // everything" leak into the gate.
    const candidates = await db
      .select()
      .from(evalResponseScores)
      .where(
        and(
          eq(evalResponseScores.verdict, "failed"),
          sql`${evalResponseScores.ratifiedBy} IS NOT NULL`,
        ),
      )
      .orderBy(
        evalResponseScores.failureClass,
        sql`(${evalResponseScores.goldAnswer} is null) asc`,
        desc(evalResponseScores.createdAt),
      );

    const seen = new Set<string>();
    const deduped = [];
    const countsByClass: Record<string, number> = {};
    for (const row of candidates) {
      countsByClass[row.failureClass] = (countsByClass[row.failureClass] ?? 0) + 1;
      if (!seen.has(row.failureClass)) {
        seen.add(row.failureClass);
        deduped.push(row);
      }
    }

    return c.json(
      { items: deduped, countsByClass, totalRatifiedFailed: candidates.length } as any,
      200,
    );
  } catch (error) {
    logger.error("Failed to load bench candidates", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── List response scores ─────────────────────────────────────────────────────

const listScoresRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Eval"],
  summary: "List eval response scores",
  request: {
    query: z.object({
      verdict: z.string().optional(),
      failureClass: z.string().optional(),
      scorable: z.string().optional(),
      ratified: z.string().optional(),
      userId: z.string().optional(),
      threadTs: z.string().optional(),
      search: z.string().optional(),
      page: z.coerce.number().optional(),
      limit: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: listResponseSchema } },
      description: "Success",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardEvalApp.openapi(listScoresRoute, async (c) => {
  try {
    const verdict = c.req.query("verdict");
    const failureClass = c.req.query("failureClass");
    const scorable = c.req.query("scorable");
    const ratified = c.req.query("ratified");
    const userId = c.req.query("userId");
    const threadTs = c.req.query("threadTs");
    const search = c.req.query("search");
    const page = parseInt(c.req.query("page") || "1", 10);
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = (page - 1) * limit;

    const conditions: SQL[] = [];
    if (verdict && verdict !== "all") {
      if ((evalVerdicts as readonly string[]).includes(verdict)) {
        conditions.push(eq(evalResponseScores.verdict, verdict as any));
      } else if (verdict === "none") {
        conditions.push(sql`${evalResponseScores.verdict} IS NULL`);
      }
    }
    if (
      failureClass &&
      failureClass !== "all" &&
      (evalFailureClasses as readonly string[]).includes(failureClass)
    ) {
      conditions.push(eq(evalResponseScores.failureClass, failureClass as any));
    }
    if (scorable === "true") conditions.push(eq(evalResponseScores.scorable, true));
    if (scorable === "false") conditions.push(eq(evalResponseScores.scorable, false));
    if (ratified === "true")
      conditions.push(sql`${evalResponseScores.ratifiedBy} IS NOT NULL`);
    if (ratified === "false")
      conditions.push(sql`${evalResponseScores.ratifiedBy} IS NULL`);
    if (userId) conditions.push(eq(conversationTraces.userId, userId));
    if (threadTs) conditions.push(eq(evalResponseScores.threadTs, threadTs));
    if (search) {
      conditions.push(
        sql`(${evalResponseScores.servingIntent} ILIKE ${"%" + search + "%"} OR ${evalResponseScores.note} ILIKE ${"%" + search + "%"})`,
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [{ value: total }] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(evalResponseScores)
      .innerJoin(
        conversationTraces,
        eq(evalResponseScores.traceId, conversationTraces.id),
      )
      .where(where);

    const rows = await db
      .select({
        score: evalResponseScores,
        traceUserId: conversationTraces.userId,
        traceChannelId: conversationTraces.channelId,
        traceModelId: conversationTraces.modelId,
        traceCostUsd: conversationTraces.costUsd,
        traceCreatedAt: conversationTraces.createdAt,
      })
      .from(evalResponseScores)
      .innerJoin(
        conversationTraces,
        eq(evalResponseScores.traceId, conversationTraces.id),
      )
      .where(where)
      .orderBy(desc(conversationTraces.createdAt), desc(evalResponseScores.createdAt))
      .limit(limit)
      .offset(offset);

    const userIds = [
      ...new Set(rows.map((r) => r.traceUserId).filter(Boolean)),
    ] as string[];
    let userNames: Record<string, string> = {};
    if (userIds.length > 0) {
      const profileRows = await db
        .select({ slackUserId: users.slackUserId, displayName: users.displayName })
        .from(users)
        .where(sql`${users.slackUserId} IN ${userIds}`);
      userNames = Object.fromEntries(
        profileRows.map((r) => [r.slackUserId, r.displayName]),
      );
    }

    const items = rows.map((row) => ({
      ...row.score,
      userId: row.traceUserId,
      channelId: row.traceChannelId,
      modelId: row.traceModelId,
      costUsd: row.traceCostUsd,
      respondedAt: row.traceCreatedAt,
      resolvedName: row.traceUserId ? userNames[row.traceUserId] ?? null : null,
    }));

    return c.json({ items, total } as any, 200);
  } catch (error) {
    logger.error("Failed to list eval scores", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── Single score ─────────────────────────────────────────────────────────────

const getScoreRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Eval"],
  summary: "Get a single eval response score",
  request: { params: idParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardEvalApp.openapi(getScoreRoute, async (c) => {
  try {
    const id = c.req.param("id");
    const [row] = await db
      .select({
        score: evalResponseScores,
        traceUserId: conversationTraces.userId,
        traceChannelId: conversationTraces.channelId,
        traceModelId: conversationTraces.modelId,
        traceCostUsd: conversationTraces.costUsd,
        traceCreatedAt: conversationTraces.createdAt,
      })
      .from(evalResponseScores)
      .innerJoin(
        conversationTraces,
        eq(evalResponseScores.traceId, conversationTraces.id),
      )
      .where(eq(evalResponseScores.id, id));

    if (!row) return c.json({ error: "Not found" }, 404);

    return c.json(
      {
        ...row.score,
        userId: row.traceUserId,
        channelId: row.traceChannelId,
        modelId: row.traceModelId,
        costUsd: row.traceCostUsd,
        respondedAt: row.traceCreatedAt,
      } as any,
      200,
    );
  } catch (error) {
    logger.error("Failed to get eval score", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── Adjudicate (note / gold / rubric / ratify) ───────────────────────────────

const patchScoreSchema = z.object({
  note: z.string().nullable().optional(),
  goldAnswer: z.string().nullable().optional(),
  rubric: z
    .object({
      must_do: z.array(z.string()).optional(),
      must_not_do: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
  /** True ratifies as the session user (or provided name); false un-ratifies. */
  ratify: z.boolean().optional(),
  ratifiedBy: z.string().nullable().optional(),
});

const patchScoreRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Eval"],
  summary: "Adjudicate a response score (note, gold answer, rubric, ratify)",
  request: {
    params: idParamSchema,
    body: {
      content: { "application/json": { schema: patchScoreSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardEvalApp.openapi(patchScoreRoute, async (c) => {
  try {
    const id = c.req.param("id");
    const body = patchScoreSchema.parse(await c.req.json());

    const updates: Partial<typeof evalResponseScores.$inferInsert> = {};
    if (body.note !== undefined) updates.note = body.note;
    if (body.goldAnswer !== undefined) updates.goldAnswer = body.goldAnswer;
    if (body.rubric !== undefined) updates.rubric = body.rubric;
    if (body.ratify !== undefined || body.ratifiedBy !== undefined) {
      if (body.ratify === false || body.ratifiedBy === null) {
        updates.ratifiedBy = null;
      } else {
        const sessionUser =
          (c.get("userName" as never) as string | undefined) ||
          (c.get("userId" as never) as string | undefined);
        updates.ratifiedBy = body.ratifiedBy ?? sessionUser ?? "dashboard";
      }
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "No fields to update" }, 400 as any);
    }

    const [updated] = await db
      .update(evalResponseScores)
      .set(updates)
      .where(eq(evalResponseScores.id, id))
      .returning();

    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json(updated as any, 200);
  } catch (error) {
    logger.error("Failed to update eval score", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

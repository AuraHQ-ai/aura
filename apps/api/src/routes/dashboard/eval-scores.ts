import { createRoute, z } from "@hono/zod-openapi";
import { desc, eq, sql } from "drizzle-orm";
import {
  conversationTraces,
  evalResponseScores,
  users,
} from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { createDashboardApp, errorSchema } from "./schemas.js";

export const dashboardEvalScoresApp = createDashboardApp();

const failureClassSchema = z.enum([
  "missing_cred",
  "bad_memory",
  "bad_harness",
  "missing_tool",
  "reasoning",
  "latency",
  "none",
]);

const summaryQuerySchema = z.object({
  failureClass: failureClassSchema.or(z.literal("all")).optional(),
  servingIntent: z.string().optional(),
  userId: z.string().optional(),
});

const patchScoreSchema = z.object({
  note: z.string().max(10_000).nullable().optional(),
  goldAnswer: z.string().max(20_000).nullable().optional(),
  rubric: z
    .object({
      must_do: z.array(z.string()).optional(),
      must_not_do: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
  ratified: z.boolean().optional(),
});

type QueryResult<T> = { rows?: T[] } | T[];

function getRows<T>(result: QueryResult<T>): T[] {
  return Array.isArray(result) ? result : result.rows ?? [];
}

function numberValue(value: unknown): number {
  if (value == null) return 0;
  return Number(value);
}

const getSummaryRoute = createRoute({
  method: "get",
  path: "/summary",
  tags: ["Eval Scores"],
  summary: "Get response eval funnel summary",
  request: {
    query: summaryQuerySchema,
  },
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

dashboardEvalScoresApp.openapi(getSummaryRoute, async (c) => {
  try {
    const q = c.req.valid("query");
    const failureClass = q.failureClass && q.failureClass !== "all" ? q.failureClass : null;
    const servingIntent = q.servingIntent?.trim() || null;
    const userId = q.userId?.trim() || null;

    const totals = getRows<{
      total: number | string;
      scorable: number | string;
      fulfilled: number | string;
      partial: number | string;
      failed: number | string;
      ratified_failed: number | string;
      cost_usd: number | string | null;
    }>(await db.execute(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE ers.scorable)::int AS scorable,
        count(*) FILTER (WHERE ers.verdict = 'fulfilled')::int AS fulfilled,
        count(*) FILTER (WHERE ers.verdict = 'partial')::int AS partial,
        count(*) FILTER (WHERE ers.verdict = 'failed')::int AS failed,
        count(*) FILTER (WHERE ers.verdict = 'failed' AND ers.ratified_by IS NOT NULL)::int AS ratified_failed,
        coalesce(sum(ct.cost_usd::numeric), 0)::float AS cost_usd
      FROM eval_response_scores ers
      JOIN conversation_traces ct ON ct.id = ers.trace_id
      WHERE (${failureClass}::text IS NULL OR ers.failure_class = ${failureClass})
        AND (${servingIntent}::text IS NULL OR ers.serving_intent ILIKE '%' || ${servingIntent} || '%')
        AND (${userId}::text IS NULL OR ct.user_id = ${userId})
    `))[0] ?? {
      total: 0,
      scorable: 0,
      fulfilled: 0,
      partial: 0,
      failed: 0,
      ratified_failed: 0,
      cost_usd: 0,
    };

    const byFailureClass = getRows<{
      failure_class: string;
      count: number | string;
      failed: number | string;
    }>(await db.execute(sql`
      SELECT
        ers.failure_class,
        count(*)::int AS count,
        count(*) FILTER (WHERE ers.verdict = 'failed')::int AS failed
      FROM eval_response_scores ers
      JOIN conversation_traces ct ON ct.id = ers.trace_id
      WHERE (${servingIntent}::text IS NULL OR ers.serving_intent ILIKE '%' || ${servingIntent} || '%')
        AND (${userId}::text IS NULL OR ct.user_id = ${userId})
      GROUP BY ers.failure_class
      ORDER BY failed DESC, count DESC
    `));

    const byServingIntent = getRows<{
      serving_intent: string | null;
      count: number | string;
      failed: number | string;
      cost_usd: number | string | null;
    }>(await db.execute(sql`
      SELECT
        ers.serving_intent,
        count(*)::int AS count,
        count(*) FILTER (WHERE ers.verdict = 'failed')::int AS failed,
        coalesce(sum(ct.cost_usd::numeric), 0)::float AS cost_usd
      FROM eval_response_scores ers
      JOIN conversation_traces ct ON ct.id = ers.trace_id
      WHERE (${failureClass}::text IS NULL OR ers.failure_class = ${failureClass})
        AND (${userId}::text IS NULL OR ct.user_id = ${userId})
        AND ers.serving_intent IS NOT NULL
      GROUP BY ers.serving_intent
      ORDER BY failed DESC, count DESC
      LIMIT 25
    `));

    const recentFailures = await db
      .select({
        partId: evalResponseScores.partId,
        traceId: evalResponseScores.traceId,
        threadTs: evalResponseScores.threadTs,
        servingIntent: evalResponseScores.servingIntent,
        failureClass: evalResponseScores.failureClass,
        note: evalResponseScores.note,
        ratifiedBy: evalResponseScores.ratifiedBy,
        createdAt: evalResponseScores.createdAt,
        userId: conversationTraces.userId,
        channelId: conversationTraces.channelId,
        costUsd: conversationTraces.costUsd,
        displayName: users.displayName,
      })
      .from(evalResponseScores)
      .innerJoin(conversationTraces, eq(conversationTraces.id, evalResponseScores.traceId))
      .leftJoin(users, eq(users.slackUserId, conversationTraces.userId))
      .where(sql`
        ${evalResponseScores.verdict} = 'failed'
        AND (${failureClass}::text IS NULL OR ${evalResponseScores.failureClass} = ${failureClass})
        AND (${servingIntent}::text IS NULL OR ${evalResponseScores.servingIntent} ILIKE '%' || ${servingIntent} || '%')
        AND (${userId}::text IS NULL OR ${conversationTraces.userId} = ${userId})
      `)
      .orderBy(desc(evalResponseScores.createdAt))
      .limit(50);

    return c.json({
      filters: { failureClass, servingIntent, userId },
      summary: {
        total: numberValue(totals.total),
        scorable: numberValue(totals.scorable),
        fulfilled: numberValue(totals.fulfilled),
        partial: numberValue(totals.partial),
        failed: numberValue(totals.failed),
        ratifiedFailed: numberValue(totals.ratified_failed),
        costUsd: numberValue(totals.cost_usd),
      },
      byFailureClass: byFailureClass.map((row) => ({
        failureClass: row.failure_class,
        count: numberValue(row.count),
        failed: numberValue(row.failed),
      })),
      byServingIntent: byServingIntent.map((row) => ({
        servingIntent: row.serving_intent,
        count: numberValue(row.count),
        failed: numberValue(row.failed),
        costUsd: numberValue(row.cost_usd),
      })),
      recentFailures,
    } as any);
  } catch (error) {
    logger.error("Failed to load eval score summary", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const patchScoreRoute = createRoute({
  method: "patch",
  path: "/{partId}",
  tags: ["Eval Scores"],
  summary: "Update human eval score annotations",
  request: {
    params: z.object({
      partId: z.string().uuid().openapi({ param: { name: "partId", in: "path" } }),
    }),
    body: {
      content: {
        "application/json": {
          schema: patchScoreSchema,
        },
      },
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

dashboardEvalScoresApp.openapi(patchScoreRoute, async (c) => {
  try {
    const partId = c.req.param("partId");
    const body = c.req.valid("json");
    const update: Partial<typeof evalResponseScores.$inferInsert> = {};

    if ("note" in body) update.note = body.note?.trim() || null;
    if ("goldAnswer" in body) update.goldAnswer = body.goldAnswer?.trim() || null;
    if ("rubric" in body) update.rubric = body.rubric ?? null;
    if ("ratified" in body) {
      const userId = c.get("userId" as never) as string | undefined;
      update.ratifiedBy = body.ratified ? userId || "dashboard_api" : null;
    }

    if (Object.keys(update).length === 0) {
      const [existing] = await db
        .select()
        .from(evalResponseScores)
        .where(eq(evalResponseScores.partId, partId))
        .limit(1);
      if (!existing) return c.json({ error: "Not found" }, 404);
      return c.json(existing as any);
    }

    const [row] = await db
      .update(evalResponseScores)
      .set(update)
      .where(eq(evalResponseScores.partId, partId))
      .returning();

    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row as any);
  } catch (error) {
    logger.error("Failed to update eval score", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

import { createRoute, z } from "@hono/zod-openapi";
import { conversationTraces } from "@aura/db/schema";
import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, createDashboardApp } from "./schemas.js";

export const dashboardConsumptionApp = createDashboardApp();

const getConsumptionRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Consumption"],
  summary: "Get cost and token consumption data (last 30 days)",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            dailyCost: z.array(z.object({
              date: z.string(),
              cost: z.number(),
              conversations: z.number(),
            })),
            perUser: z.array(z.any()),
            perJob: z.array(z.any()),
            totals: z.object({
              totalCost: z.number(),
              conversations: z.number(),
              avgDailyCost: z.number(),
            }),
            tokenBreakdown: z.object({
              cacheRead: z.number(),
              cacheWrite: z.number(),
              uncached: z.number(),
              output: z.number(),
            }),
          }),
        },
      },
      description: "Success",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardConsumptionApp.openapi(getConsumptionRoute, async (c) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const dailyCostRows = await db
      .select({
        date: sql<string>`date_trunc('day', ${conversationTraces.createdAt})::date::text`.as("date"),
        cost: sql<string>`coalesce(sum(${conversationTraces.costUsd}), 0)`.as("cost"),
        conversations: sql<number>`count(*)::int`.as("conversations"),
      })
      .from(conversationTraces)
      .where(sql`${conversationTraces.costUsd} IS NOT NULL AND ${conversationTraces.createdAt} >= ${thirtyDaysAgo}`)
      .groupBy(sql`date_trunc('day', ${conversationTraces.createdAt})::date`)
      .orderBy(sql`date_trunc('day', ${conversationTraces.createdAt})::date`);

    const dailyCost = dailyCostRows.map((d) => ({
      date: d.date,
      cost: Number(d.cost),
      conversations: Number(d.conversations),
    }));

    const interactiveResult = await db.execute(sql`
      SELECT
        ct.user_id,
        up.display_name,
        COALESCE(SUM(ct.cost_usd), 0) AS interactive_cost,
        COUNT(*)::int AS conversations
      FROM conversation_traces ct
      LEFT JOIN user_profiles up ON up.slack_user_id = ct.user_id
      WHERE ct.cost_usd IS NOT NULL
        AND ct.created_at >= ${thirtyDaysAgo}
        AND ct.source_type = 'interactive'
      GROUP BY ct.user_id, up.display_name
    `);

    const jobCostResult = await db.execute(sql`
      SELECT
        j.requested_by AS user_id,
        up.display_name,
        COALESCE(SUM(ct.cost_usd), 0) AS job_cost,
        COUNT(*)::int AS conversations
      FROM conversation_traces ct
      JOIN job_executions je ON je.id = ct.job_execution_id
      JOIN jobs j ON j.id = je.job_id
      LEFT JOIN user_profiles up ON up.slack_user_id = j.requested_by
      WHERE ct.cost_usd IS NOT NULL
        AND ct.created_at >= ${thirtyDaysAgo}
        AND ct.source_type = 'job_execution'
      GROUP BY j.requested_by, up.display_name
    `);

    const interactiveRows = ((interactiveResult as any).rows ?? interactiveResult) as Array<{
      user_id: string;
      display_name: string | null;
      interactive_cost: string;
      conversations: number;
    }>;

    const jobCostRows = ((jobCostResult as any).rows ?? jobCostResult) as Array<{
      user_id: string;
      display_name: string | null;
      job_cost: string;
      conversations: number;
    }>;

    const userMap = new Map<string, {
      userId: string;
      displayName: string | null;
      interactiveCost: number;
      jobCost: number;
      totalCost: number;
      conversations: number;
    }>();

    for (const row of interactiveRows) {
      const ic = Number(row.interactive_cost);
      userMap.set(row.user_id, {
        userId: row.user_id,
        displayName: row.display_name,
        interactiveCost: ic,
        jobCost: 0,
        totalCost: ic,
        conversations: Number(row.conversations),
      });
    }

    for (const row of jobCostRows) {
      const jc = Number(row.job_cost);
      const existing = userMap.get(row.user_id);
      if (existing) {
        existing.jobCost = jc;
        existing.totalCost += jc;
        existing.conversations += Number(row.conversations);
      } else {
        userMap.set(row.user_id, {
          userId: row.user_id,
          displayName: row.display_name,
          interactiveCost: 0,
          jobCost: jc,
          totalCost: jc,
          conversations: Number(row.conversations),
        });
      }
    }

    const perUser = Array.from(userMap.values())
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 20);

    const perJobResult = await db.execute(sql`
      SELECT
        j.name AS job_name,
        up.display_name AS creator_name,
        COUNT(DISTINCT je.id)::int AS execution_count,
        COALESCE(SUM(ct.cost_usd), 0) AS total_cost
      FROM conversation_traces ct
      JOIN job_executions je ON je.id = ct.job_execution_id
      JOIN jobs j ON j.id = je.job_id
      LEFT JOIN user_profiles up ON up.slack_user_id = j.requested_by
      WHERE ct.cost_usd IS NOT NULL
        AND ct.created_at >= ${thirtyDaysAgo}
        AND ct.source_type = 'job_execution'
      GROUP BY j.name, up.display_name
      ORDER BY total_cost DESC
      LIMIT 20
    `);

    const perJobRows = ((perJobResult as any).rows ?? perJobResult) as Array<{
      job_name: string | null;
      creator_name: string | null;
      execution_count: number;
      total_cost: string;
    }>;

    const perJob = perJobRows.map((j) => ({
      jobName: j.job_name,
      creatorName: j.creator_name,
      executionCount: Number(j.execution_count),
      totalCost: Number(j.total_cost),
    }));

    const [totalsRow] = await db
      .select({
        totalCost: sql<string>`coalesce(sum(${conversationTraces.costUsd}), 0)`.as("total_cost"),
        conversations: sql<number>`count(*)::int`.as("conversations"),
      })
      .from(conversationTraces)
      .where(sql`${conversationTraces.costUsd} IS NOT NULL AND ${conversationTraces.createdAt} >= ${thirtyDaysAgo}`);

    const totalCost = Number(totalsRow.totalCost);
    const conversations = Number(totalsRow.conversations);
    const avgDailyCost = dailyCost.length > 0 ? totalCost / dailyCost.length : 0;

    const tokenResult = await db.execute(sql`
      SELECT
        COALESCE(SUM(("token_usage"->'inputTokenDetails'->>'cacheReadTokens')::bigint), 0) AS cache_read,
        COALESCE(SUM(("token_usage"->'inputTokenDetails'->>'cacheWriteTokens')::bigint), 0) AS cache_write,
        COALESCE(SUM(COALESCE(
          ("token_usage"->'inputTokenDetails'->>'noCacheTokens')::bigint,
          GREATEST(0, ("token_usage"->>'inputTokens')::bigint
            - COALESCE(("token_usage"->'inputTokenDetails'->>'cacheReadTokens')::bigint, 0)
            - COALESCE(("token_usage"->'inputTokenDetails'->>'cacheWriteTokens')::bigint, 0))
        )), 0) AS uncached,
        COALESCE(SUM(("token_usage"->>'outputTokens')::bigint), 0) AS output_tokens
      FROM conversation_traces
      WHERE cost_usd IS NOT NULL AND created_at >= ${thirtyDaysAgo}
    `);

    const tokenRows = ((tokenResult as any).rows ?? tokenResult) as Array<{
      cache_read: string;
      cache_write: string;
      uncached: string;
      output_tokens: string;
    }>;
    const tb = tokenRows[0];

    return c.json(
      {
        dailyCost,
        perUser,
        perJob,
        totals: { totalCost, conversations, avgDailyCost },
        tokenBreakdown: {
          cacheRead: Number(tb?.cache_read || 0),
          cacheWrite: Number(tb?.cache_write || 0),
          uncached: Number(tb?.uncached || 0),
          output: Number(tb?.output_tokens || 0),
        },
      } as any,
      200,
    );
  } catch (error) {
    logger.error("Failed to fetch consumption data", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

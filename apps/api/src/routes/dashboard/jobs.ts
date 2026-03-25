import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql, ilike, desc } from "drizzle-orm";
import { jobs, jobExecutions, conversationTraces } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, paginationQuerySchema, idParamSchema } from "./schemas.js";

export const dashboardJobsApp = new OpenAPIHono();

const listJobsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Jobs"],
  summary: "List jobs",
  request: {
    query: paginationQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(z.any()),
            total: z.number(),
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

dashboardJobsApp.openapi(listJobsRoute, async (c) => {
  try {
    const search = c.req.query("search") ?? "";
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10)));
    const offset = (page - 1) * limit;

    const where = search ? ilike(jobs.name, `%${search}%`) : undefined;

    const [items, countResult] = await Promise.all([
      db
        .select()
        .from(jobs)
        .where(where)
        .orderBy(desc(jobs.updatedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobs)
        .where(where),
    ]);

    return c.json({ items, total: countResult[0]?.count ?? 0 } as any, 200);
  } catch (error) {
    logger.error("Failed to list jobs", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const getJobRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Jobs"],
  summary: "Get job detail with executions",
  request: {
    params: idParamSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            job: z.any(),
            executions: z.array(z.any()),
          }),
        },
      },
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

dashboardJobsApp.openapi(getJobRoute, async (c) => {
  try {
    const id = c.req.param("id");

    const jobRows = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, id))
      .limit(1);

    if (jobRows.length === 0) {
      return c.json({ error: "Job not found" }, 404);
    }

    const job = jobRows[0];

    const executions = await db
      .select()
      .from(jobExecutions)
      .where(eq(jobExecutions.jobId, id))
      .orderBy(desc(jobExecutions.startedAt))
      .limit(50);

    const executionIds = executions.map((e) => e.id);
    let traceMap: Record<string, { costUsd: string | null; traceId: string }> = {};

    if (executionIds.length > 0) {
      const traces = await db
        .select({
          jobExecutionId: conversationTraces.jobExecutionId,
          costUsd: conversationTraces.costUsd,
          traceId: conversationTraces.id,
        })
        .from(conversationTraces)
        .where(sql`${conversationTraces.jobExecutionId} IN ${executionIds}`);

      for (const t of traces) {
        if (t.jobExecutionId) {
          traceMap[t.jobExecutionId] = { costUsd: t.costUsd, traceId: t.traceId };
        }
      }
    }

    const enrichedExecutions = executions.map((e) => ({
      ...e,
      costUsd: traceMap[e.id]?.costUsd ?? null,
      conversationTraceId: traceMap[e.id]?.traceId ?? null,
    }));

    return c.json({ job, executions: enrichedExecutions } as any, 200);
  } catch (error) {
    logger.error("Failed to get job detail", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const toggleJobRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Jobs"],
  summary: "Toggle job enabled/disabled",
  request: {
    params: idParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({ enabled: z.boolean() }),
        },
      },
      required: true,
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

dashboardJobsApp.openapi(toggleJobRoute, async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<{ enabled: boolean }>();

    const result = await db
      .update(jobs)
      .set({
        enabled: body.enabled ? 1 : 0,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, id))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "Job not found" }, 404);
    }

    return c.json(result[0] as any, 200);
  } catch (error) {
    logger.error("Failed to toggle job", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

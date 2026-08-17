import { createRoute, z } from "@hono/zod-openapi";
import { eq, sql, ilike, desc, and, gte, inArray } from "drizzle-orm";
import { jobs, jobExecutions, conversationTraces } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { JOB_MODEL_CATEGORIES } from "../../lib/ai.js";
import { WATCHDOG_RESET_MARKER } from "../../cron/job-watchdog.js";
import { buildTaskPrefix } from "../../personality/system-prompt.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, paginationQuerySchema, idParamSchema, createDashboardApp } from "./schemas.js";

/** Env var NAMES only (never values) — standard POSIX-style identifier. */
const ENV_VAR_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * All fields optional: omitted = leave unchanged, explicit null = clear the
 * override (model → medium default, envAllowlist → full inheritance,
 * promptMode → full prompt).
 */
export const updateJobBodySchema = z.object({
  enabled: z.boolean().optional(),
  model: z.enum(JOB_MODEL_CATEGORIES).nullable().optional(),
  envAllowlist: z
    .array(
      z
        .string()
        .regex(ENV_VAR_NAME_REGEX, "must be a valid env var name (letters, digits, underscores)"),
    )
    .max(100)
    .nullable()
    .optional(),
  promptMode: z.enum(["full", "task"]).nullable().optional(),
});

export const dashboardJobsApp = createDashboardApp();

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

    // ── Cost aggregation (single query, no N+1) ─────────────────────────
    // Join job_executions → conversation_traces over the last 30 days.
    // SUM(cost_usd) is nullable: traces may have no cost row yet.

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const jobIds = items.map((j) => j.id);

    type CostStat = { runs30d: number; cost30dUsd: string | null };
    const costByJobId = new Map<string, CostStat>();

    if (jobIds.length > 0) {
      const stats = await db
        .select({
          jobId: jobExecutions.jobId,
          runs30d: sql<number>`count(distinct ${jobExecutions.id})::int`,
          cost30dUsd: sql<string | null>`sum(${conversationTraces.costUsd})::text`,
        })
        .from(jobExecutions)
        .leftJoin(
          conversationTraces,
          eq(conversationTraces.jobExecutionId, jobExecutions.id),
        )
        .where(
          and(
            inArray(jobExecutions.jobId, jobIds),
            gte(jobExecutions.startedAt, thirtyDaysAgo),
          ),
        )
        .groupBy(jobExecutions.jobId);

      for (const s of stats) {
        if (s.jobId) costByJobId.set(s.jobId, { runs30d: s.runs30d, cost30dUsd: s.cost30dUsd });
      }
    }

    const enrichedItems = items.map((job) => {
      const stat = costByJobId.get(job.id);
      const runs30d = stat?.runs30d ?? 0;
      const cost30dUsd = stat?.cost30dUsd ?? null;
      const avgCostPerRunUsd =
        runs30d > 0 && cost30dUsd !== null
          ? (parseFloat(cost30dUsd) / runs30d).toFixed(6)
          : null;
      const wasWatchdogReset = Boolean(job.result?.includes(WATCHDOG_RESET_MARKER));
      return { ...job, runs30d, cost30dUsd, avgCostPerRunUsd, wasWatchdogReset };
    });

    return c.json({ items: enrichedItems, total: countResult[0]?.count ?? 0 } as any, 200);
  } catch (error) {
    logger.error("Failed to list jobs", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const taskPromptRoute = createRoute({
  method: "get",
  path: "/task-prompt",
  tags: ["Jobs"],
  summary: "Get the prompt_mode='task' system prefix",
  description:
    "Returns the current buildTaskPrefix() output — the minimal system prefix used when a job runs with promptMode='task'. Rendered live from code so dashboard previews and docs never drift.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ prompt: z.string() }),
        },
      },
      description: "Success",
    },
  },
});

// Registered before the /{id} route so the static segment can't be captured
// as a job id.
dashboardJobsApp.openapi(taskPromptRoute, (c) => {
  return c.json({ prompt: buildTaskPrefix() } as any, 200);
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
    type TraceInfo = { costUsd: string | null; traceId: string; resolvedModelId: string | null };
    let traceMap: Record<string, TraceInfo> = {};

    if (executionIds.length > 0) {
      const traces = await db
        .select({
          jobExecutionId: conversationTraces.jobExecutionId,
          costUsd: conversationTraces.costUsd,
          traceId: conversationTraces.id,
          resolvedModelId: conversationTraces.resolvedModelId,
        })
        .from(conversationTraces)
        .where(sql`${conversationTraces.jobExecutionId} IN ${executionIds}`);

      for (const t of traces) {
        if (t.jobExecutionId) {
          traceMap[t.jobExecutionId] = {
            costUsd: t.costUsd,
            traceId: t.traceId,
            resolvedModelId: t.resolvedModelId,
          };
        }
      }
    }

    const enrichedExecutions = executions.map((e) => ({
      ...e,
      costUsd: traceMap[e.id]?.costUsd ?? null,
      conversationTraceId: traceMap[e.id]?.traceId ?? null,
      resolvedModelId: traceMap[e.id]?.resolvedModelId ?? null,
    }));

    return c.json({ job, executions: enrichedExecutions } as any, 200);
  } catch (error) {
    logger.error("Failed to get job detail", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const updateJobRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Jobs"],
  summary: "Update job (enabled, model, env allowlist, prompt mode)",
  request: {
    params: idParamSchema,
    body: {
      content: {
        "application/json": {
          schema: updateJobBodySchema,
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
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Validation error",
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

dashboardJobsApp.openapi(updateJobRoute, async (c) => {
  try {
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const set: Partial<typeof jobs.$inferInsert> = { updatedAt: new Date() };
    if (body.enabled !== undefined) set.enabled = body.enabled ? 1 : 0;
    if (body.model !== undefined) set.model = body.model;
    if (body.envAllowlist !== undefined) set.envAllowlist = body.envAllowlist;
    if (body.promptMode !== undefined) set.promptMode = body.promptMode;

    const result = await db
      .update(jobs)
      .set(set)
      .where(eq(jobs.id, id))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "Job not found" }, 404);
    }

    return c.json(result[0] as any, 200);
  } catch (error) {
    logger.error("Failed to update job", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

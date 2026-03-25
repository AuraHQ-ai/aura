import { createRoute, z } from "@hono/zod-openapi";
import { count, desc, eq, gte } from "drizzle-orm";
import {
  notes,
  memories,
  userProfiles,
  jobs,
  errorEvents,
  jobExecutions,
} from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, createDashboardApp } from "./schemas.js";

export const dashboardStatsApp = createDashboardApp();

const getStatsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Stats"],
  summary: "Get dashboard statistics",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            notes: z.number(),
            memories: z.number(),
            users: z.number(),
            activeJobs: z.number(),
            errorsLast24h: z.number(),
            recentErrors: z.array(z.any()),
            recentExecutions: z.array(z.any()),
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

dashboardStatsApp.openapi(getStatsRoute, async (c) => {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      [notesCount],
      [memoriesCount],
      [usersCount],
      [activeJobsCount],
      [recentErrorsCount],
      recentErrors,
      recentExecutions,
    ] = await Promise.all([
      db.select({ value: count() }).from(notes),
      db.select({ value: count() }).from(memories),
      db.select({ value: count() }).from(userProfiles),
      db.select({ value: count() }).from(jobs).where(eq(jobs.enabled, 1)),
      db
        .select({ value: count() })
        .from(errorEvents)
        .where(gte(errorEvents.timestamp, oneDayAgo)),
      db
        .select({
          id: errorEvents.id,
          errorName: errorEvents.errorName,
          errorCode: errorEvents.errorCode,
          timestamp: errorEvents.timestamp,
          resolved: errorEvents.resolved,
        })
        .from(errorEvents)
        .orderBy(desc(errorEvents.timestamp))
        .limit(5),
      db
        .select({
          id: jobExecutions.id,
          jobId: jobExecutions.jobId,
          status: jobExecutions.status,
          startedAt: jobExecutions.startedAt,
          finishedAt: jobExecutions.finishedAt,
          trigger: jobExecutions.trigger,
        })
        .from(jobExecutions)
        .orderBy(desc(jobExecutions.startedAt))
        .limit(5),
    ]);

    return c.json(
      {
        notes: notesCount.value,
        memories: memoriesCount.value,
        users: usersCount.value,
        activeJobs: activeJobsCount.value,
        errorsLast24h: recentErrorsCount.value,
        recentErrors,
        recentExecutions,
      } as any,
      200,
    );
  } catch (error) {
    logger.error("Failed to fetch dashboard stats", { error });
    return c.json({ error: "Failed to fetch stats" }, 500);
  }
});

import { Hono } from "hono";
import { eq, and, lt, lte, sql, isNull, or, inArray } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { db } from "../db/client.js";
import { jobs, notes, jobExecutions } from "@aura/db/schema";
import type { FrequencyConfig } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { executeJob, MAX_RETRIES } from "./execute-job.js";

/** Max jobs to process per heartbeat sweep */
const MAX_JOBS_PER_SWEEP = 10;

/** Threshold for recovering jobs stuck in "running" (15 minutes) */
const STALE_RUNNING_THRESHOLD_MS = 15 * 60 * 1000;

// ── Job Eligibility (recurring jobs) ─────────────────────────────────────────

function isRecurringJobDue(job: typeof jobs.$inferSelect): boolean {
  const now = new Date();

  if (job.cronSchedule) {
    try {
      // Offset by 1 s so that prev() includes the current boundary tick.
      // Without this, prev() is exclusive of currentDate and misses the
      // exact scheduled second, causing jobs to skip their on-time tick.
      const cron = CronExpressionParser.parse(job.cronSchedule, {
        currentDate: new Date(now.getTime() + 1000),
        tz: job.timezone || undefined,
      });
      const lastCronTick = cron.prev().toDate();

      if (job.lastExecutedAt && job.lastExecutedAt >= lastCronTick) {
        return false;
      }
      if (!job.lastExecutedAt && job.createdAt >= lastCronTick) {
        return false;
      }
    } catch {
      logger.warn("isRecurringJobDue: invalid cron, skipping", {
        jobName: job.name,
        cronSchedule: job.cronSchedule,
      });
      return false;
    }
  }

  const config = job.frequencyConfig as FrequencyConfig | null;
  if (!config) return true;

  if (config.minIntervalHours && job.lastExecutedAt) {
    const minIntervalMs = config.minIntervalHours * 60 * 60 * 1000;
    if (now < new Date(job.lastExecutedAt.getTime() + minIntervalMs)) return false;
  }

  if (config.maxPerDay) {
    const todayStr = now.toISOString().slice(0, 10);
    const executionsToday =
      job.lastExecutionDate === todayStr ? job.todayExecutions : 0;
    if (executionsToday >= config.maxPerDay) return false;
  }

  if (config.cooldownHours && job.lastExecutedAt) {
    const cooldownMs = config.cooldownHours * 60 * 60 * 1000;
    if (now < new Date(job.lastExecutedAt.getTime() + cooldownMs)) return false;
  }

  return true;
}

// ── Heartbeat Cron App ───────────────────────────────────────────────────────

export const heartbeatApp = new Hono();

heartbeatApp.get("/api/cron/heartbeat", async (c) => {
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("Unauthorized heartbeat cron invocation");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const sweepStart = Date.now();
  logger.info("Heartbeat starting");

  let executed = 0;
  let failed = 0;
  let plansExpired = 0;
  let plansAbandoned = 0;
  let staleRunningRecovered = 0;

  try {
    const now = new Date();

    // ── 1. Query all pending enabled jobs ────────────────────────────────

    const pendingJobs = await db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "pending"),
          eq(jobs.enabled, 1),
          or(
            // One-shot/continuation: due when executeAt <= now
            lte(jobs.executeAt, now),
            // Recurring: no executeAt, has cron or frequency (needs app-side eval)
            and(
              isNull(jobs.executeAt),
              sql`(${jobs.cronSchedule} IS NOT NULL AND ${jobs.cronSchedule} != '' OR ${jobs.frequencyConfig} IS NOT NULL)`,
            ),
          ),
        ),
      )
      .orderBy(
        sql`CASE WHEN ${jobs.priority} = 'high' THEN 0 WHEN ${jobs.priority} = 'normal' THEN 1 ELSE 2 END`,
        sql`${jobs.lastExecutedAt} ASC NULLS FIRST`,
        sql`${jobs.executeAt} ASC NULLS LAST`,
      );

    // ── 2. Filter to due jobs ────────────────────────────────────────────

    const dueJobs: (typeof jobs.$inferSelect)[] = [];

    for (const job of pendingJobs) {
      if (dueJobs.length >= MAX_JOBS_PER_SWEEP) break;

      if (job.executeAt) {
        // One-shot or continuation: already filtered by DB (executeAt <= now)
        dueJobs.push(job);
      } else if (job.cronSchedule || job.frequencyConfig) {
        // Recurring: evaluate cron + frequency guards
        if (isRecurringJobDue(job)) {
          dueJobs.push(job);
        }
      }
    }

    if (dueJobs.length > 0) {
      logger.info(`Heartbeat: ${dueJobs.length} jobs due (of ${pendingJobs.length} pending)`);

      for (const job of dueJobs) {
        try {
          const ran = await executeJob(job, "heartbeat");
          if (ran) executed++;
        } catch (error: any) {
          logger.error("Heartbeat: job execution error", {
            jobName: job.name,
            error: error.message,
          });
          failed++;
        }
      }
    } else {
      logger.info(`Heartbeat: no jobs due (${pendingJobs.length} pending)`);
    }

    // ── 3. Expire stale plan notes ───────────────────────────────────────

    const expireResult = await db
      .delete(notes)
      .where(and(eq(notes.category, "plan"), lte(notes.expiresAt, now)))
      .returning({ topic: notes.topic });

    plansExpired = expireResult.length;
    if (plansExpired > 0) {
      logger.info(`Heartbeat: expired ${plansExpired} plan notes`, {
        topics: expireResult.map((r) => r.topic),
      });
    }

    // ── 4. Flag abandoned plans ──────────────────────────────────────────

    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const stalePlans = await db
      .select({ topic: notes.topic })
      .from(notes)
      .where(
        and(
          eq(notes.category, "plan"),
          lt(notes.updatedAt, twoDaysAgo),
          or(isNull(notes.expiresAt), sql`${notes.expiresAt} > NOW()`),
        ),
      );

    plansAbandoned = stalePlans.length;
    if (plansAbandoned > 0) {
      logger.warn(`Heartbeat: ${plansAbandoned} potentially abandoned plans`, {
        topics: stalePlans.map((p) => p.topic),
      });
    }

    // ── 5. Recover jobs stuck in "running" ─────────────────────────────

    const staleRunningCutoff = new Date(Date.now() - STALE_RUNNING_THRESHOLD_MS);
    const staleRunning = await db
      .update(jobs)
      .set({
        status: "pending",
        retries: sql`${jobs.retries} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.status, "running"),
          lt(jobs.updatedAt, staleRunningCutoff),
          lt(jobs.retries, MAX_RETRIES),
        ),
      )
      .returning({ id: jobs.id, name: jobs.name });

    const staleExhausted = await db
      .update(jobs)
      .set({
        status: "failed",
        result: "Failed: job stuck in running state and exceeded retry limit",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.status, "running"),
          lt(jobs.updatedAt, staleRunningCutoff),
        ),
      )
      .returning({ id: jobs.id, name: jobs.name });

    const allStaleIds = [
      ...staleRunning.map((j) => j.id),
      ...staleExhausted.map((j) => j.id),
    ];

    if (allStaleIds.length > 0) {
      await db
        .update(jobExecutions)
        .set({
          status: "failed",
          finishedAt: new Date(),
          error: "Execution interrupted: recovered by stale detection",
        })
        .where(
          and(
            inArray(jobExecutions.jobId, allStaleIds),
            eq(jobExecutions.status, "running"),
          ),
        );
    }

    staleRunningRecovered = staleRunning.length;
    if (staleRunningRecovered > 0) {
      logger.warn(`Heartbeat: recovered ${staleRunningRecovered} stale running jobs`, {
        jobs: staleRunning.map((j) => j.name),
      });
    }
    if (staleExhausted.length > 0) {
      logger.error(`Heartbeat: ${staleExhausted.length} stale jobs exceeded retry limit`, {
        jobs: staleExhausted.map((j) => j.name),
      });
    }

    // ── Done ─────────────────────────────────────────────────────────────

    const duration = Date.now() - sweepStart;
    logger.info(`Heartbeat completed in ${duration}ms`, {
      executed,
      failed,
      plansExpired,
      plansAbandoned,
      staleRunningRecovered,
    });

    return c.json({ ok: true, executed, failed, plansExpired, plansAbandoned, staleRunningRecovered, duration });
  } catch (error: any) {
    logger.error("Heartbeat failed", { error: error.message });
    return c.json({ error: "Heartbeat failed" }, 500);
  }
});

// ── Execute Now (on-demand dispatch) ─────────────────────────────────────────

heartbeatApp.post("/api/execute-now", async (c) => {
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("Unauthorized execute-now invocation");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { jobId } = await c.req.json<{ jobId?: string }>();

  if (!jobId) return c.json({ error: "jobId required" }, 400);

  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) return c.json({ error: "Job not found" }, 404);

  if (job.status !== "pending") {
    return c.json(
      { ok: false, jobId, error: `Job is not pending (current status: ${job.status})` },
      409,
    );
  }

  try {
    const executed = await executeJob(job, "dispatch");

    if (!executed) {
      return c.json({ ok: false, jobId, message: "Job was not executed (already claimed)" }, 409);
    }

    return c.json({ ok: true, jobId, message: "Execution completed" });
  } catch (err: any) {
    logger.error("execute-now failed", { jobId, error: err.message });
    return c.json({ ok: false, jobId, error: err.message }, 500);
  }
});


import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { eq, and, lt, lte, sql, isNull, or } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { db } from "../db/client.js";
import { jobs, notes, jobExecutions } from "../db/schema.js";
import type { FrequencyConfig } from "../db/schema.js";
import { buildSkillIndex } from "../lib/skill-index.js";
import { logger } from "../lib/logger.js";
import { executeJob, MAX_RETRIES, RETRY_DELAY_MS } from "./execute-job.js";

const botToken = process.env.SLACK_BOT_TOKEN || "";
const slackClient = new WebClient(botToken);

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

// ── Shared Retry/Escalation Helper ──────────────────────────────────────────

async function handleJobRetry(
  job: { id: string; name: string; retries: number; requestedBy: string | null; description: string },
  errorMessage: string,
  currentTime: Date = new Date()
): Promise<'retried' | 'failed'> {
  const newRetries = job.retries + 1;

  if (newRetries < MAX_RETRIES) {
    await db
      .update(jobs)
      .set({
        status: "pending",
        executeAt: new Date(currentTime.getTime() + RETRY_DELAY_MS),
        retries: newRetries,
        lastExecutedAt: currentTime,
        updatedAt: currentTime,
      })
      .where(eq(jobs.id, job.id));

    return 'retried';
  } else {
    await db
      .update(jobs)
      .set({
        status: "failed",
        retries: newRetries,
        lastExecutedAt: currentTime,
        result: `Permanently failed after ${MAX_RETRIES} retries: ${errorMessage}`,
        updatedAt: currentTime,
      })
      .where(eq(jobs.id, job.id));

    // Send escalation DM
    try {
      if (job.requestedBy && job.requestedBy !== "aura") {
        const dmResult = await slackClient.conversations.open({
          users: job.requestedBy,
        });
        if (dmResult.channel?.id) {
          await slackClient.chat.postMessage({
            channel: dmResult.channel.id,
            text: `I tried ${MAX_RETRIES} times but couldn't complete this job: "${job.description}"\n\nError: ${errorMessage}`,
          });
        }
      }
    } catch {
      logger.error("Failed to send escalation DM", { jobId: job.id });
    }

    return 'failed';
  }
}

// ── Consolidated Stale Job Recovery ──────────────────────────────────────────

async function recoverStaleJobs(): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_THRESHOLD_MS);

  // Find stale executions with their parent job details
  const staleExecutions = await db
    .select({
      executionId: jobExecutions.id,
      jobId: jobExecutions.jobId,
      startedAt: jobExecutions.startedAt,
      jobName: jobs.name,
      jobRetries: jobs.retries,
      jobRequestedBy: jobs.requestedBy,
      jobDescription: jobs.description,
      jobStatus: jobs.status,
    })
    .from(jobExecutions)
    .innerJoin(jobs, eq(jobExecutions.jobId, jobs.id))
    .where(
      and(
        eq(jobExecutions.status, "running"),
        lt(jobExecutions.startedAt, staleCutoff),
      ),
    );

  let recovered = 0;

  for (const stale of staleExecutions) {
    const now = new Date();
    const elapsedMinutes = Math.round(
      (now.getTime() - stale.startedAt.getTime()) / 60000,
    );

    // Update execution to failed (with optimistic lock)
    const updatedExecution = await db
      .update(jobExecutions)
      .set({
        status: "failed",
        finishedAt: now,
        error: `Vercel timeout (inferred) -- execution exceeded ${STALE_RUNNING_THRESHOLD_MS / 60000} minute ceiling`,
      })
      .where(
        and(
          eq(jobExecutions.id, stale.executionId),
          eq(jobExecutions.status, "running")
        )
      )
      .returning({ id: jobExecutions.id });

    if (updatedExecution.length === 0) continue;

    recovered++;

    // Only handle job retry if job is still in running state (prevents double-processing)
    if (stale.jobStatus === "running") {
      const result = await handleJobRetry(
        {
          id: stale.jobId!,
          name: stale.jobName!,
          retries: stale.jobRetries!,
          requestedBy: stale.jobRequestedBy,
          description: stale.jobDescription!,
        },
        "Execution timed out repeatedly (Vercel ceiling exceeded)",
        now
      );

      logger.warn("Recovered stale job", {
        jobName: stale.jobName,
        jobId: stale.jobId,
        elapsedMinutes,
        result,
      });
    } else {
      logger.info("Cleaned up stale execution (job already handled)", {
        executionId: stale.executionId,
        jobId: stale.jobId,
        jobStatus: stale.jobStatus,
      });
    }
  }

  return recovered;
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
  let staleJobsReaped = 0;

  try {
    // ── 0. Recover stale jobs and executions ─────────────────────────────

    staleJobsReaped = await recoverStaleJobs();
    if (staleJobsReaped > 0) {
      logger.info(`Heartbeat: recovered ${staleJobsReaped} stale job executions`);
    }

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

      const skillIndex = await buildSkillIndex();

      for (const job of dueJobs) {
        try {
          const ran = await executeJob(job, skillIndex, "heartbeat");
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

    // ── 5. [REMOVED] Old stale recovery logic - now handled in step 0 ────

    // Stale job recovery is now consolidated in step 0 (recoverStaleJobs)
    staleRunningRecovered = 0; // This metric is now captured in staleJobsReaped

    // ── Done ─────────────────────────────────────────────────────────────

    const duration = Date.now() - sweepStart;
    logger.info(`Heartbeat completed in ${duration}ms`, {
      executed,
      failed,
      plansExpired,
      plansAbandoned,
      staleRunningRecovered,
      staleJobsReaped,
    });

    return c.json({ ok: true, executed, failed, plansExpired, plansAbandoned, staleRunningRecovered, staleJobsReaped, duration });
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
    const skillIndex = await buildSkillIndex();
    const executed = await executeJob(job, skillIndex, "dispatch");

    if (!executed) {
      return c.json({ ok: false, jobId, message: "Job was not executed (already claimed)" }, 409);
    }

    return c.json({ ok: true, jobId, message: "Execution completed" });
  } catch (err: any) {
    logger.error("execute-now failed", { jobId, error: err.message });
    return c.json({ ok: false, jobId, error: err.message }, 500);
  }
});


import { Hono } from "hono";
import { eq, and, lt, lte, gte, sql, isNull, or, inArray } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { db } from "../db/client.js";
import { jobs, notes, jobExecutions, jobOutcomes } from "@aura/db/schema";
import type { FrequencyConfig } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { executeJob, MAX_RETRIES } from "./execute-job.js";
import { computeNextCronTick } from "./cron-utils.js";
import { persistJobOutcome, triggerSupervisorReview } from "./job-outcomes.js";
import { sendJobOpsNotice } from "./job-notifications.js";

/** Max jobs to process per heartbeat sweep */
const MAX_JOBS_PER_SWEEP = 10;

/** Threshold for recovering jobs stuck in "running" (15 minutes) */
const STALE_RUNNING_THRESHOLD_MS = 15 * 60 * 1000;

const ORPHAN_SWEEP_BATCH_SIZE = 20;
const PENDING_REVIEW_ORPHAN_THRESHOLD_MS = 5 * 60 * 1000;
const IN_PROGRESS_ORPHAN_THRESHOLD_MS = 10 * 60 * 1000;
const DEQUEUED_WITHOUT_EXECUTION_THRESHOLD_MS = 10 * 60 * 1000;
const MAX_SUPERVISOR_ATTEMPTS = 3;

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

type OrphanSweepResult = {
  pendingReviewRefired: number;
  inProgressReset: number;
  inProgressSkipped: number;
  dequeuedWithoutExecution: number;
};

async function notifySupervisorRetriesExhausted(job: Pick<typeof jobs.$inferSelect, "id" | "name" | "requestedBy">): Promise<void> {
  // Internal ops notice — routed to the ops channel / founder DM, never the
  // end user's DM when an ops destination is configured.
  const result = await sendJobOpsNotice({
    jobId: job.id,
    jobName: job.name,
    requestedBy: job.requestedBy,
    text: `Supervisor for job ${job.name} exhausted retries; manual intervention needed`,
    logContext: { event: "orphan_sweep_supervisor_retry_exhausted" },
  });

  if (!result.ok) {
    logger.warn("orphan_sweep_supervisor_retry_exhausted_notice_failed", {
      jobId: job.id,
      requestedBy: job.requestedBy,
      target: result.target,
    });
  }
}

export async function sweepOrphanedOutcomes(now = new Date()): Promise<OrphanSweepResult> {
  const pendingReviewCutoff = new Date(now.getTime() - PENDING_REVIEW_ORPHAN_THRESHOLD_MS);
  const inProgressCutoff = new Date(now.getTime() - IN_PROGRESS_ORPHAN_THRESHOLD_MS);
  const dequeuedWithoutExecutionCutoff = new Date(
    now.getTime() - DEQUEUED_WITHOUT_EXECUTION_THRESHOLD_MS,
  );

  let pendingReviewRefired = 0;
  let inProgressReset = 0;
  let inProgressSkipped = 0;
  let dequeuedWithoutExecution = 0;

  const pendingReviewOutcomes = await db
    .select({ id: jobOutcomes.id })
    .from(jobOutcomes)
    .where(
      and(
        eq(jobOutcomes.supervisorStatus, "pending_review"),
        lt(jobOutcomes.createdAt, pendingReviewCutoff),
      ),
    )
    .orderBy(jobOutcomes.createdAt)
    .limit(ORPHAN_SWEEP_BATCH_SIZE);

  for (const outcome of pendingReviewOutcomes) {
    triggerSupervisorReview(outcome.id);
  }
  pendingReviewRefired = pendingReviewOutcomes.length;

  const inProgressOutcomes = await db
    .select({
      id: jobOutcomes.id,
      jobId: jobOutcomes.jobId,
      supervisorAttempts: jobOutcomes.supervisorAttempts,
    })
    .from(jobOutcomes)
    .where(
      and(
        eq(jobOutcomes.supervisorStatus, "in_progress"),
        lt(jobOutcomes.supervisorStartedAt, inProgressCutoff),
      ),
    )
    .orderBy(jobOutcomes.supervisorStartedAt)
    .limit(ORPHAN_SWEEP_BATCH_SIZE);

  for (const outcome of inProgressOutcomes) {
    if (outcome.supervisorAttempts < MAX_SUPERVISOR_ATTEMPTS) {
      const reset = await db
        .update(jobOutcomes)
        .set({
          supervisorStatus: "pending_review",
          supervisorInvocationId: null,
          supervisorStartedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(jobOutcomes.id, outcome.id),
            eq(jobOutcomes.supervisorStatus, "in_progress"),
            lt(jobOutcomes.supervisorAttempts, MAX_SUPERVISOR_ATTEMPTS),
          ),
        )
        .returning({ id: jobOutcomes.id });

      if (reset.length > 0) {
        inProgressReset++;
        triggerSupervisorReview(outcome.id);
      }
      continue;
    }

    const skipped = await db
      .update(jobOutcomes)
      .set({
        supervisorStatus: "skipped",
        supervisorReasoning: "max supervisor attempts exceeded",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobOutcomes.id, outcome.id),
          eq(jobOutcomes.supervisorStatus, "in_progress"),
          gte(jobOutcomes.supervisorAttempts, MAX_SUPERVISOR_ATTEMPTS),
        ),
      )
      .returning({ id: jobOutcomes.id, jobId: jobOutcomes.jobId });

    if (skipped.length === 0) continue;

    inProgressSkipped++;
    const [job] = await db
      .select({ id: jobs.id, name: jobs.name, requestedBy: jobs.requestedBy })
      .from(jobs)
      .where(eq(jobs.id, outcome.jobId))
      .limit(1);

    if (job) {
      await notifySupervisorRetriesExhausted(job);
    }
  }

  const dequeuedJobs = await db
    .select({
      id: jobs.id,
      workspaceId: jobs.workspaceId,
      name: jobs.name,
      executeAt: jobs.executeAt,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "running"),
        or(isNull(jobs.lastExecutedAt), lt(jobs.lastExecutedAt, dequeuedWithoutExecutionCutoff)),
        sql`NOT EXISTS (
          SELECT 1
          FROM ${jobExecutions}
          WHERE ${jobExecutions.jobId} = ${jobs.id}
            AND ${jobExecutions.startedAt} >= COALESCE(${jobs.executeAt}, ${jobs.updatedAt}) - interval '1 minute'
        )`,
      ),
    )
    .orderBy(jobs.updatedAt)
    .limit(ORPHAN_SWEEP_BATCH_SIZE);

  for (const job of dequeuedJobs) {
    const outcomeId = await persistJobOutcome({
      workspaceId: job.workspaceId,
      jobId: job.id,
      jobExecutionId: null,
      outcomeStatus: "process_died_pre_execution",
      output: {
        type: "process_died_pre_execution",
        recovered_by: "heartbeat",
        execute_at: job.executeAt?.toISOString() ?? null,
        dequeued_at: job.updatedAt.toISOString(),
      },
      error: "Job was dequeued but no execution row was created",
      lastNSteps: [],
    });

    await db
      .update(jobs)
      .set({
        status: "failed",
        result: "Failed: worker died before creating a job execution row",
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));

    dequeuedWithoutExecution++;
    triggerSupervisorReview(outcomeId);
  }

  logger.info("Heartbeat: orphaned outcome sweep completed", {
    pendingReviewRefired,
    inProgressReset,
    inProgressSkipped,
    dequeuedWithoutExecution,
  });

  return {
    pendingReviewRefired,
    inProgressReset,
    inProgressSkipped,
    dequeuedWithoutExecution,
  };
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
  let pendingReviewOutcomesRefired = 0;
  let inProgressOutcomesReset = 0;
  let inProgressOutcomesSkipped = 0;
  let dequeuedWithoutExecutionRecovered = 0;

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

    const orphanSweepResult = await sweepOrphanedOutcomes(now);
    pendingReviewOutcomesRefired = orphanSweepResult.pendingReviewRefired;
    inProgressOutcomesReset = orphanSweepResult.inProgressReset;
    inProgressOutcomesSkipped = orphanSweepResult.inProgressSkipped;
    dequeuedWithoutExecutionRecovered = orphanSweepResult.dequeuedWithoutExecution;

    // ── 5. Recover jobs stuck in "running" ─────────────────────────────

    const staleRunningCutoff = new Date(now.getTime() - STALE_RUNNING_THRESHOLD_MS);
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
      .returning({ id: jobs.id, name: jobs.name, workspaceId: jobs.workspaceId });

    const staleExhausted = await db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "running"),
          lt(jobs.updatedAt, staleRunningCutoff),
          gte(jobs.retries, MAX_RETRIES),
        ),
      );

    const recoveredRecurringJobs: Array<{ id: string; name: string; executeAt: Date }> = [];
    const failedExhaustedJobs: Array<{ id: string; name: string }> = [];

    for (const job of staleExhausted) {
      if (job.cronSchedule != null) {
        try {
          const executeAt = computeNextCronTick(job.cronSchedule, job.timezone, now);

          await db
            .update(jobs)
            .set({
              status: "pending",
              retries: 0,
              executeAt,
              updatedAt: new Date(),
            })
            .where(eq(jobs.id, job.id));

          recoveredRecurringJobs.push({ id: job.id, name: job.name, executeAt });
          logger.warn("recurring_job_recovered_after_exhaustion", {
            jobId: job.id,
            jobName: job.name,
            cronSchedule: job.cronSchedule,
            timezone: job.timezone,
            executeAt: executeAt.toISOString(),
          });

        } catch (error: any) {
          await db
            .update(jobs)
            .set({
              status: "failed",
              result: `Failed: job stuck in running state and exceeded retry limit; auto-recovery failed: ${error?.message ?? "invalid cron schedule"}`,
              updatedAt: new Date(),
            })
            .where(eq(jobs.id, job.id));

          failedExhaustedJobs.push({ id: job.id, name: job.name });
          logger.error("recurring_job_recovery_failed", {
            jobId: job.id,
            jobName: job.name,
            cronSchedule: job.cronSchedule,
            timezone: job.timezone,
            error: error?.message,
          });
        }
      } else {
        await db
          .update(jobs)
          .set({
            status: "failed",
            result: "Failed: job stuck in running state and exceeded retry limit",
            updatedAt: new Date(),
          })
          .where(eq(jobs.id, job.id));

        failedExhaustedJobs.push({ id: job.id, name: job.name });
      }
    }

    const allStaleIds = [
      ...staleRunning.map((j) => j.id),
      ...staleExhausted.map((j) => j.id),
    ];

    let interruptedExecutions: Array<{ id: string; jobId: string | null }> = [];

    if (allStaleIds.length > 0) {
      interruptedExecutions = await db
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
        )
        .returning({ id: jobExecutions.id, jobId: jobExecutions.jobId });
    }

    if (allStaleIds.length > 0) {
      const staleJobs = [
        ...staleRunning,
        ...staleExhausted.map((job) => ({
          id: job.id,
          name: job.name,
          workspaceId: job.workspaceId,
        })),
      ];
      const jobIdsWithExecutionOutcomes = new Set<string>();

      for (const execution of interruptedExecutions) {
        if (!execution.jobId) continue;

        const job = staleJobs.find((candidate) => candidate.id === execution.jobId);
        if (!job) continue;

        jobIdsWithExecutionOutcomes.add(job.id);
        const outcomeId = await persistJobOutcome({
          workspaceId: job.workspaceId,
          jobId: job.id,
          jobExecutionId: execution.id,
          outcomeStatus: "interrupted",
          output: {
            type: "stale_recovery",
            recovered_by: "heartbeat",
            stale_running_threshold_ms: STALE_RUNNING_THRESHOLD_MS,
          },
          error: "Execution interrupted: recovered by stale detection",
          lastNSteps: [],
        });
        triggerSupervisorReview(outcomeId);
      }

      for (const job of staleJobs) {
        if (jobIdsWithExecutionOutcomes.has(job.id)) continue;

        const outcomeId = await persistJobOutcome({
          workspaceId: job.workspaceId,
          jobId: job.id,
          jobExecutionId: null,
          outcomeStatus: "interrupted",
          output: {
            type: "stale_recovery",
            recovered_by: "heartbeat",
            stale_running_threshold_ms: STALE_RUNNING_THRESHOLD_MS,
          },
          error: "Execution interrupted: recovered by stale detection",
          lastNSteps: [],
        });
        triggerSupervisorReview(outcomeId);
      }
    }

    staleRunningRecovered = staleRunning.length;
    if (staleRunningRecovered > 0) {
      logger.warn(`Heartbeat: recovered ${staleRunningRecovered} stale running jobs`, {
        jobs: staleRunning.map((j) => j.name),
      });
    }
    if (staleExhausted.length > 0) {
      logger.error(`Heartbeat: ${staleExhausted.length} stale jobs exceeded retry limit`, {
        recoveredRecurringJobs: recoveredRecurringJobs.map((j) => j.name),
        failedJobs: failedExhaustedJobs.map((j) => j.name),
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
      pendingReviewOutcomesRefired,
      inProgressOutcomesReset,
      inProgressOutcomesSkipped,
      dequeuedWithoutExecutionRecovered,
    });

    return c.json({
      ok: true,
      executed,
      failed,
      plansExpired,
      plansAbandoned,
      staleRunningRecovered,
      pendingReviewOutcomesRefired,
      inProgressOutcomesReset,
      inProgressOutcomesSkipped,
      dequeuedWithoutExecutionRecovered,
      duration,
    });
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


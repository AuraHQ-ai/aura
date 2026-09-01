import { and, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { jobs, jobExecutions } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { isSuspensionActive } from "../lib/job-suspension.js";
import { computeNextCronTick } from "./cron-utils.js";

// ── Stuck-job watchdog ────────────────────────────────────────────────────────
//
// Complements the 15-minute retry sweep in heartbeat.ts: if a job execution
// has been in "running" status for longer than STUCK_JOB_THRESHOLD_MINUTES it
// is terminated immediately (never retried) and recurring jobs are rescheduled
// to their next cron slot.  This is the hard backstop that prevents executions
// from blocking the heartbeat queue indefinitely.

/** Default staleness threshold in minutes.  Override via a constant here; we
 *  intentionally do NOT tie this to a runtime env var because the value is
 *  part of the error message written to the DB and should be stable. */
export const STUCK_JOB_THRESHOLD_MINUTES = 45;
export const STUCK_JOB_THRESHOLD_MS = STUCK_JOB_THRESHOLD_MINUTES * 60 * 1000;

/** Substring written into `jobs.result` on every watchdog reset.  The
 *  dashboard uses this marker to render a badge without a separate DB column. */
export const WATCHDOG_RESET_MARKER = "reset by watchdog";

/** Max stuck executions processed per sweep. */
const WATCHDOG_BATCH_SIZE = 20;

export interface StuckJobsSweepResult {
  /** Stuck executions found this sweep. */
  detected: number;
  /** Executions atomically claimed and marked failed. */
  markedFailed: number;
  /** Recurring parent jobs requeued to their next cron slot. */
  requeued: number;
  /** Executions skipped because they are webhook-suspended (issue #1326). */
  skippedSuspended: number;
}

/**
 * Detect job executions that have been stuck in "running" status for longer
 * than STUCK_JOB_THRESHOLD_MINUTES and terminate them.
 *
 * - Idempotent: every DB write uses a `status = 'running'` WHERE guard so
 *   concurrent heartbeat invocations cannot double-process the same row.
 * - Safe: never throws — the heartbeat must not fail because of this sweep.
 * - One-shot jobs → marked failed.
 * - Recurring jobs → execution marked failed + parent job rescheduled to the
 *   next cron tick with retries reset to 0.
 */
export async function sweepStuckJobs(now = new Date()): Promise<StuckJobsSweepResult> {
  const result: StuckJobsSweepResult = {
    detected: 0,
    markedFailed: 0,
    requeued: 0,
    skippedSuspended: 0,
  };

  try {
    const cutoff = new Date(now.getTime() - STUCK_JOB_THRESHOLD_MS);

    const stuckExecutions = await db
      .select({
        id: jobExecutions.id,
        jobId: jobExecutions.jobId,
        startedAt: jobExecutions.startedAt,
        suspendedUntil: jobExecutions.suspendedUntil,
      })
      .from(jobExecutions)
      .where(
        and(
          eq(jobExecutions.status, "running"),
          lt(jobExecutions.startedAt, cutoff),
          // Webhook-suspended executions are parked, not hung (issue #1326):
          // leave them alone until their suspension deadline elapses.
          or(
            isNull(jobExecutions.suspendedUntil),
            lte(jobExecutions.suspendedUntil, now),
          ),
        ),
      )
      .orderBy(jobExecutions.startedAt)
      .limit(WATCHDOG_BATCH_SIZE);

    result.detected = stuckExecutions.length;
    if (stuckExecutions.length === 0) return result;

    const jobIds = [
      ...new Set(stuckExecutions.map((e) => e.jobId).filter((id): id is string => id !== null)),
    ];

    const jobRows =
      jobIds.length > 0
        ? await db
            .select({
              id: jobs.id,
              name: jobs.name,
              cronSchedule: jobs.cronSchedule,
              timezone: jobs.timezone,
              workspaceId: jobs.workspaceId,
            })
            .from(jobs)
            .where(inArray(jobs.id, jobIds))
        : [];

    const jobMap = new Map(jobRows.map((j) => [j.id, j]));

    for (const exec of stuckExecutions) {
      // Defence in depth for the SQL-level suspension filter above: a row
      // suspended between the SELECT and this loop iteration (or one leaking
      // through a stale read) must still not be killed while parked.
      if (isSuspensionActive(exec.suspendedUntil, now)) {
        result.skippedSuspended++;
        continue;
      }

      const ageMs = now.getTime() - exec.startedAt.getTime();
      const ageMinutes = Math.round(ageMs / 60_000);
      const errorMsg = `Stale: no completion signal after ${ageMinutes}m, ${WATCHDOG_RESET_MARKER}`;

      // Atomic claim — only the first concurrent sweep wins.
      const claimed = await db
        .update(jobExecutions)
        .set({
          status: "failed",
          finishedAt: now,
          error: errorMsg,
        })
        .where(
          and(
            eq(jobExecutions.id, exec.id),
            eq(jobExecutions.status, "running"),
          ),
        )
        .returning({ id: jobExecutions.id });

      if (claimed.length === 0) continue; // another sweep claimed it first

      result.markedFailed++;

      if (!exec.jobId) continue;
      const job = jobMap.get(exec.jobId);
      if (!job) continue;

      logger.warn("job_watchdog_stuck_execution_reset", {
        executionId: exec.id,
        jobId: job.id,
        jobName: job.name,
        ageMinutes,
        staleThresholdMinutes: STUCK_JOB_THRESHOLD_MINUTES,
      });

      if (job.cronSchedule) {
        // Recurring: reschedule to the next cron tick.
        let executeAt: Date;
        try {
          executeAt = computeNextCronTick(job.cronSchedule, job.timezone, now);
        } catch {
          // Invalid cron expression — just mark the job failed.
          await db
            .update(jobs)
            .set({
              status: "failed",
              result: `${errorMsg}; requeue skipped: invalid cron expression`,
              updatedAt: now,
            })
            .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));
          continue;
        }

        await db
          .update(jobs)
          .set({
            status: "pending",
            result: errorMsg,
            executeAt,
            retries: 0,
            updatedAt: now,
          })
          .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));

        result.requeued++;

        logger.warn("job_watchdog_recurring_requeued", {
          jobId: job.id,
          jobName: job.name,
          executeAt: executeAt.toISOString(),
        });
      } else {
        // One-shot: mark the parent job failed.
        await db
          .update(jobs)
          .set({
            status: "failed",
            result: errorMsg,
            updatedAt: now,
          })
          .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));
      }
    }

    if (result.detected > 0) {
      logger.warn("job_watchdog_sweep_completed", {
        detected: result.detected,
        markedFailed: result.markedFailed,
        requeued: result.requeued,
        skippedSuspended: result.skippedSuspended,
        staleThresholdMinutes: STUCK_JOB_THRESHOLD_MINUTES,
      });
    }
  } catch (err: unknown) {
    logger.error("job_watchdog_sweep_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

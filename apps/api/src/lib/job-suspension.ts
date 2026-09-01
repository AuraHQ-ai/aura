import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { jobs, jobExecutions } from "@aura/db/schema";
import { logger } from "./logger.js";

// ── Webhook-suspension marker for job executions (issue #1326) ───────────────
//
// A job whose agent dispatches a detached sandbox command with a webhook
// resume is legitimately parked, not hung. Without a marker it is
// indistinguishable from a hung job (`status = 'running'` with a frozen
// `updated_at`), so the heartbeat's 15-minute stale sweep and the 45-minute
// stuck-job watchdog kill it, retry it, and eventually exhaust its retries.
// This module writes an explicit `suspended_until` deadline on both the jobs
// row and the job_executions row at dispatch time; the sweeps skip suspended
// rows until that deadline elapses (or the detached-command watchdog declares
// the command dead and clears the shield).

/**
 * How long a webhook-suspended job is shielded from stale-kill. Must be
 * comfortably longer than the detached-command hard max (750s) plus the
 * detached-command watchdog staleness threshold (20 min default), so the
 * command-level watchdog always gets the first say on a lost webhook.
 */
export const SUSPENDED_JOB_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * True when a `suspended_until` deadline is set and still in the future —
 * i.e. the row must be excluded from stale-kill sweeps.
 */
export function isSuspensionActive(
  suspendedUntil: Date | null | undefined,
  now: Date,
): boolean {
  return suspendedUntil != null && suspendedUntil.getTime() > now.getTime();
}

/**
 * Mark a job (and its execution trace row) as suspended awaiting a
 * detached-command webhook resume. Called from the run_command_detached
 * dispatch path when a webhook resume is possible. Also bumps
 * `jobs.updated_at` so the run stays visibly fresh.
 *
 * Never throws — a marking failure must not break the dispatch itself.
 */
export async function markJobSuspendedForDetachedCommand({
  jobId,
  jobExecutionId,
  commandId,
  now = new Date(),
}: {
  jobId: string | null;
  jobExecutionId: string | null;
  commandId: string;
  now?: Date;
}): Promise<void> {
  const suspendedUntil = new Date(now.getTime() + SUSPENDED_JOB_TIMEOUT_MS);

  try {
    if (jobId) {
      await db
        .update(jobs)
        .set({ suspendedUntil, updatedAt: now })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")));
    }
    if (jobExecutionId) {
      await db
        .update(jobExecutions)
        .set({ suspendedUntil })
        .where(
          and(eq(jobExecutions.id, jobExecutionId), eq(jobExecutions.status, "running")),
        );
    }

    logger.info("job_suspended_awaiting_webhook", {
      jobId,
      jobExecutionId,
      commandId,
      suspendedUntil: suspendedUntil.toISOString(),
    });
  } catch (error: unknown) {
    logger.warn("job_suspension_marking_failed", {
      jobId,
      jobExecutionId,
      commandId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Clear the suspension shield on a job whose detached command was declared
 * dead (webhook never arrived). The normal stale sweeps can then recover the
 * job immediately instead of waiting for the full suspension window.
 *
 * Never throws.
 */
export async function clearJobSuspension(jobId: string): Promise<void> {
  try {
    await db
      .update(jobs)
      .set({ suspendedUntil: null, updatedAt: new Date() })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")));
  } catch (error: unknown) {
    logger.warn("job_suspension_clear_failed", {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

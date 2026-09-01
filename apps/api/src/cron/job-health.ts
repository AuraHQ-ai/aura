import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { jobs, jobExecutions } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { sendJobOpsNotice, truncateJobFailureText } from "./job-notifications.js";

// ── Job failure health scan (issue #762) ─────────────────────────────────────
//
// Failed jobs used to pile up silently: nothing scanned accumulated failures,
// so a job could fail every run for weeks with zero signal. This sweep runs
// on every heartbeat and sends one ops notice (sendJobOpsNotice plumbing —
// ops channel → founder DM → requester DM) per unhealthy job.
//
// Deduplication: a job is only a candidate when one of its executions FAILED
// within the last heartbeat interval, so each new failure is evaluated by
// exactly one sweep — an unhealthy job that simply stays dormant does not
// re-alert every 30 minutes.

// ── Configurable thresholds ──────────────────────────────────────────────────

/** Alert when a job's most recent finished executions are N consecutive failures. */
export const CONSECUTIVE_FAILURE_ALERT_THRESHOLD = 3;

/** Alert when none of the job's last X finished executions succeeded. */
export const NO_SUCCESS_WINDOW_RUNS = 10;

/**
 * Freshness window for candidate selection. Matches the heartbeat cron
 * cadence (every 30 min) so each failure is picked up by exactly one sweep.
 */
export const HEALTH_SCAN_RECENT_FAILURE_WINDOW_MS = 30 * 60 * 1000;

/** Max unhealthy jobs alerted per sweep. */
const HEALTH_SCAN_BATCH_SIZE = 20;

/** Executions fetched per job — enough to evaluate both thresholds. */
const EXECUTION_HISTORY_LIMIT = Math.max(
  CONSECUTIVE_FAILURE_ALERT_THRESHOLD,
  NO_SUCCESS_WINDOW_RUNS,
);

export interface JobHealthEvaluation {
  /** Leading run of failed executions (newest first). */
  consecutiveFailures: number;
  /** True when the last NO_SUCCESS_WINDOW_RUNS finished runs contain no success. */
  noSuccessInWindow: boolean;
}

export interface JobHealthScanResult {
  /** Jobs with a fresh failure that were evaluated. */
  scanned: number;
  /** Jobs that crossed a threshold and were reported. */
  alerted: number;
}

/**
 * Evaluate a job's health from its finished-execution statuses, ordered
 * newest first. Pure — the DB glue lives in scanJobFailureHealth.
 */
export function evaluateJobHealth(
  statusesNewestFirst: readonly string[],
  noSuccessWindowRuns = NO_SUCCESS_WINDOW_RUNS,
): JobHealthEvaluation {
  let consecutiveFailures = 0;
  for (const status of statusesNewestFirst) {
    if (status !== "failed") break;
    consecutiveFailures++;
  }

  const window = statusesNewestFirst.slice(0, noSuccessWindowRuns);
  const noSuccessInWindow =
    window.length >= noSuccessWindowRuns &&
    !window.some((status) => status === "completed");

  return { consecutiveFailures, noSuccessInWindow };
}

/**
 * Scan jobs whose latest failure is fresh (within the last heartbeat
 * interval) and report the ones with CONSECUTIVE_FAILURE_ALERT_THRESHOLD
 * consecutive failures or no success in their last NO_SUCCESS_WINDOW_RUNS
 * runs via the existing ops-notice plumbing.
 *
 * Never throws — the heartbeat must not fail because of this scan.
 */
export async function scanJobFailureHealth(now = new Date()): Promise<JobHealthScanResult> {
  const result: JobHealthScanResult = { scanned: 0, alerted: 0 };

  try {
    const freshFailureCutoff = new Date(now.getTime() - HEALTH_SCAN_RECENT_FAILURE_WINDOW_MS);

    const freshFailures = await db
      .select({ jobId: jobExecutions.jobId })
      .from(jobExecutions)
      .where(
        and(
          eq(jobExecutions.status, "failed"),
          gte(jobExecutions.finishedAt, freshFailureCutoff),
          isNotNull(jobExecutions.jobId),
        ),
      )
      .orderBy(desc(jobExecutions.finishedAt))
      .limit(200);

    const candidateJobIds = [
      ...new Set(
        freshFailures
          .map((row) => row.jobId)
          .filter((id): id is string => id !== null),
      ),
    ].slice(0, HEALTH_SCAN_BATCH_SIZE);

    if (candidateJobIds.length === 0) return result;

    const candidateJobs = await db
      .select({
        id: jobs.id,
        name: jobs.name,
        requestedBy: jobs.requestedBy,
      })
      .from(jobs)
      .where(and(inArray(jobs.id, candidateJobIds), eq(jobs.enabled, 1)));

    for (const job of candidateJobs) {
      result.scanned++;

      const recentExecutions = await db
        .select({
          status: jobExecutions.status,
          error: jobExecutions.error,
        })
        .from(jobExecutions)
        .where(
          and(
            eq(jobExecutions.jobId, job.id),
            inArray(jobExecutions.status, ["completed", "failed"]),
          ),
        )
        .orderBy(desc(jobExecutions.startedAt))
        .limit(EXECUTION_HISTORY_LIMIT);

      const health = evaluateJobHealth(recentExecutions.map((row) => row.status));

      const reasons: string[] = [];
      if (health.consecutiveFailures >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD) {
        reasons.push(`${health.consecutiveFailures} consecutive failed runs`);
      }
      if (health.noSuccessInWindow) {
        reasons.push(`no successful run in the last ${NO_SUCCESS_WINDOW_RUNS} executions`);
      }
      if (reasons.length === 0) continue;

      const lastError = truncateJobFailureText(
        recentExecutions.find((row) => row.status === "failed")?.error,
      );

      const noticeResult = await sendJobOpsNotice({
        jobId: job.id,
        jobName: job.name,
        requestedBy: job.requestedBy,
        text:
          `:rotating_light: Job health alert: ${reasons.join("; ")}.\n` +
          `Last error: \`${lastError}\``,
        logContext: {
          event: "job_health_alert",
          consecutiveFailures: health.consecutiveFailures,
          noSuccessInWindow: health.noSuccessInWindow,
        },
      });

      if (noticeResult.ok) result.alerted++;

      logger.warn("job_health_alert", {
        jobId: job.id,
        jobName: job.name,
        consecutiveFailures: health.consecutiveFailures,
        noSuccessInWindow: health.noSuccessInWindow,
        noticeSent: noticeResult.ok,
        noticeTarget: noticeResult.target,
      });
    }

    if (result.scanned > 0) {
      logger.info("job_health_scan_completed", {
        scanned: result.scanned,
        alerted: result.alerted,
      });
    }
  } catch (error: unknown) {
    logger.error("job_health_scan_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}

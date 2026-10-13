import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { db } from "../db/client.js";
import { jobs, jobExecutions } from "@aura/db/schema";
import type { FrequencyConfig } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { getSetting, setSetting } from "../lib/settings.js";
import { isSuspensionActive } from "../lib/job-suspension.js";
import { sendJobOpsNotice } from "./job-notifications.js";
import { WATCHDOG_RESET_MARKER } from "./job-watchdog.js";

// ── Scheduler-wide zero-success monitor (issue #1521) ────────────────────────
//
// Per-job health (job-health.ts) only evaluates jobs with a *fresh* failed
// execution and alerts one job at a time. The Sep 8–14 2026 outage killed
// ~2,400 runs with zero completions, and the first signal was a human noticing
// stale digests: nothing watched the *aggregate* of enabled recurring jobs.
//
// This sweep runs on every heartbeat (after the watchdogs + per-job scan) and
// raises one ops notice when expected recurring fires in a sustained window
// produce zero `completed` executions. Scope is enabled recurring jobs
// (`cronSchedule` or `frequencyConfig`); webhook-only one-shots and jobs
// currently parked on `suspendedUntil` (issue #1326) are excluded.
//
// Window / sample guard
// ---------------------
// Heartbeat cadence is 30 min. A 6h lookback spans a typical morning batch of
// daily jobs plus many hourly ticks, without waiting a full day — long enough
// that a single flaky run cannot trip it, short enough that a total outage is
// flagged before stale digests pile up. We do not alert unless
// max(expectedTicks, attempted) >= MIN_EXPECTED *and* at least
// MIN_AFFECTED_JOBS distinct jobs contribute, so a newly created job or a
// single rotting schedule stays with the per-job monitor.
//
// Dedup lives in the `settings` table (not process memory — Vercel is
// stateless). While an incident is open we stay silent; a later completed
// execution sends one recovery notice and clears the flag so a future outage
// can alert again.

/** Sustained lookback. Documented above; keep in lockstep with the alert copy. */
export const SCHEDULER_ZERO_SUCCESS_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Minimum expected-or-attempted executions in the window before we may alert. */
export const SCHEDULER_ZERO_SUCCESS_MIN_EXPECTED = 5;

/**
 * Scheduler-wide (not per-job) — a single rotting job belongs to
 * scanJobFailureHealth. Require at least this many in-scope jobs with
 * expected or attempted activity.
 */
export const SCHEDULER_ZERO_SUCCESS_MIN_AFFECTED_JOBS = 2;

/** Settings key for the open/closed incident record (JSON). */
export const SCHEDULER_ZERO_SUCCESS_SETTING_KEY = "scheduler_zero_success_incident";

const MAX_CRON_TICKS_COUNTED = 10_000;
const MAX_AFFECTED_JOBS_IN_NOTICE = 12;

export type SchedulerExecutionClass =
  | "completed"
  | "failed"
  | "interrupted"
  | "stale-killed"
  | "running"
  | "other";

export type SchedulerJobSnapshot = {
  id: string;
  name: string;
  requestedBy: string;
  createdAt: Date;
  cronSchedule: string | null;
  frequencyConfig: FrequencyConfig | null;
  timezone: string;
  lastSuccessAt: Date | null;
};

export type SchedulerExecutionSnapshot = {
  jobId: string | null;
  status: string;
  error: string | null;
  startedAt: Date;
  suspendedUntil?: Date | null;
};

export type AffectedSchedulerJob = {
  id: string;
  name: string;
  requestedBy: string;
  lastSuccessAt: Date | null;
  expected: number;
  attempted: number;
};

export type SchedulerZeroSuccessEvaluation = {
  isOutage: boolean;
  windowMs: number;
  expected: number;
  attempted: number;
  completed: number;
  failed: number;
  interrupted: number;
  staleKilled: number;
  running: number;
  sampleSize: number;
  affectedJobs: AffectedSchedulerJob[];
};

export type SchedulerZeroSuccessIncident = {
  open: boolean;
  openedAt: string;
  alertedAt?: string;
  recoveredAt?: string;
};

export type SchedulerZeroSuccessScanResult = {
  /** In-scope recurring jobs considered. */
  scanned: number;
  /** 1 when an outage notice was sent this sweep. */
  alerted: number;
  /** 1 when a recovery notice was sent this sweep. */
  recovered: number;
};

/**
 * Classify a job_executions row. There is no dedicated `interrupted` /
 * `stale-killed` status: watchdogs stamp `failed` and disambiguate via error
 * text (`WATCHDOG_RESET_MARKER` / "interrupted").
 */
export function classifySchedulerExecution(
  status: string,
  error: string | null | undefined,
): SchedulerExecutionClass {
  if (status === "completed") return "completed";
  if (status === "running") return "running";

  const err = error ?? "";
  if (err.includes(WATCHDOG_RESET_MARKER) || err.startsWith("Stale:")) {
    return "stale-killed";
  }
  if (/interrupted/i.test(err) || status === "interrupted") {
    return "interrupted";
  }
  if (status === "failed") return "failed";
  return "other";
}

/**
 * Count cron ticks in (windowStart, windowEnd]. `next()` is exclusive of
 * currentDate, so ticks exactly at windowStart are omitted (they belong to
 * the previous window). Invalid expressions return 0.
 */
export function countCronTicksInWindow(
  cronSchedule: string,
  timezone: string | null | undefined,
  windowStart: Date,
  windowEnd: Date,
): number {
  if (!cronSchedule.trim()) return 0;
  if (windowEnd.getTime() <= windowStart.getTime()) return 0;

  try {
    const cron = CronExpressionParser.parse(cronSchedule, {
      currentDate: windowStart,
      endDate: windowEnd,
      tz: timezone || undefined,
    });

    let count = 0;
    while (count < MAX_CRON_TICKS_COUNTED) {
      try {
        cron.next();
        count++;
      } catch {
        break;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function estimateFrequencyExpected(
  config: FrequencyConfig | null,
  createdAt: Date,
  windowStart: Date,
  windowEnd: Date,
): number {
  if (!config) return 0;
  const effectiveStart = createdAt.getTime() > windowStart.getTime() ? createdAt : windowStart;
  const elapsedMs = windowEnd.getTime() - effectiveStart.getTime();
  if (elapsedMs <= 0) return 0;

  const intervalHours = config.minIntervalHours ?? config.cooldownHours;
  if (!intervalHours || intervalHours <= 0) return 0;

  return Math.floor(elapsedMs / (intervalHours * 60 * 60 * 1000));
}

function expectedExecutionsForJob(
  job: Pick<SchedulerJobSnapshot, "createdAt" | "cronSchedule" | "frequencyConfig" | "timezone">,
  windowStart: Date,
  windowEnd: Date,
): number {
  // Newly created jobs do not contribute cron/frequency *expected* ticks —
  // they have not been around long enough for a sustained-window reading.
  // Actual attempts in the window still count toward the sample.
  if (job.createdAt.getTime() > windowStart.getTime()) return 0;

  const cron = job.cronSchedule?.trim() || null;
  if (cron) {
    return countCronTicksInWindow(cron, job.timezone, windowStart, windowEnd);
  }
  return estimateFrequencyExpected(job.frequencyConfig, job.createdAt, windowStart, windowEnd);
}

export function formatSchedulerWindow(windowMs: number): string {
  const hours = windowMs / (60 * 60 * 1000);
  if (hours >= 24 && hours % 24 === 0) return `${hours / 24}d`;
  if (hours >= 1 && Number.isInteger(hours)) return `${hours}h`;
  const minutes = Math.round(windowMs / 60_000);
  return `${minutes}m`;
}

function formatLastSuccess(at: Date | null): string {
  return at ? at.toISOString() : "never";
}

export function evaluateSchedulerZeroSuccess({
  jobs: jobRows,
  executions,
  now,
  windowMs = SCHEDULER_ZERO_SUCCESS_WINDOW_MS,
  minExpected = SCHEDULER_ZERO_SUCCESS_MIN_EXPECTED,
  minAffectedJobs = SCHEDULER_ZERO_SUCCESS_MIN_AFFECTED_JOBS,
}: {
  jobs: readonly SchedulerJobSnapshot[];
  executions: readonly SchedulerExecutionSnapshot[];
  now: Date;
  windowMs?: number;
  minExpected?: number;
  minAffectedJobs?: number;
}): SchedulerZeroSuccessEvaluation {
  const windowStart = new Date(now.getTime() - windowMs);
  const executionsByJob = new Map<string, SchedulerExecutionSnapshot[]>();

  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let interrupted = 0;
  let staleKilled = 0;
  let running = 0;

  for (const exec of executions) {
    if (!exec.jobId) continue;
    if (isSuspensionActive(exec.suspendedUntil, now)) continue;

    const klass = classifySchedulerExecution(exec.status, exec.error);
    attempted++;
    if (klass === "completed") completed++;
    else if (klass === "failed") failed++;
    else if (klass === "interrupted") interrupted++;
    else if (klass === "stale-killed") staleKilled++;
    else if (klass === "running") running++;

    const list = executionsByJob.get(exec.jobId) ?? [];
    list.push(exec);
    executionsByJob.set(exec.jobId, list);
  }

  let expected = 0;
  const affectedJobs: AffectedSchedulerJob[] = [];

  for (const job of jobRows) {
    const jobExpected = expectedExecutionsForJob(job, windowStart, now);
    const jobExecs = executionsByJob.get(job.id) ?? [];
    const jobAttempted = jobExecs.length;
    const jobCompleted = jobExecs.filter(
      (row) => classifySchedulerExecution(row.status, row.error) === "completed",
    ).length;

    expected += jobExpected;

    if ((jobExpected > 0 || jobAttempted > 0) && jobCompleted === 0) {
      affectedJobs.push({
        id: job.id,
        name: job.name,
        requestedBy: job.requestedBy,
        lastSuccessAt: job.lastSuccessAt,
        expected: jobExpected,
        attempted: jobAttempted,
      });
    }
  }

  const sampleSize = Math.max(expected, attempted);
  const isOutage =
    completed === 0 && sampleSize >= minExpected && affectedJobs.length >= minAffectedJobs;

  return {
    isOutage,
    windowMs,
    expected,
    attempted,
    completed,
    failed,
    interrupted,
    staleKilled,
    running,
    sampleSize,
    affectedJobs,
  };
}

export function formatSchedulerOutageNotice(evaluation: SchedulerZeroSuccessEvaluation): string {
  const windowLabel = formatSchedulerWindow(evaluation.windowMs);
  const listed = evaluation.affectedJobs.slice(0, MAX_AFFECTED_JOBS_IN_NOTICE);
  const extra = evaluation.affectedJobs.length - listed.length;
  const jobLines = listed.map(
    (job) =>
      `• \`${job.name}\` — last success ${formatLastSuccess(job.lastSuccessAt)} (expected ${job.expected}, attempted ${job.attempted})`,
  );
  if (extra > 0) jobLines.push(`• …and ${extra} more`);

  return (
    `:rotating_light: Scheduler-wide zero-success window: no completed recurring-job executions in the last ${windowLabel}.\n` +
    `Expected ${evaluation.expected} fires, attempted ${evaluation.attempted} ` +
    `(sample ${evaluation.sampleSize}; guard ≥ ${SCHEDULER_ZERO_SUCCESS_MIN_EXPECTED} across ≥ ${SCHEDULER_ZERO_SUCCESS_MIN_AFFECTED_JOBS} jobs).\n` +
    `Attempted: ${evaluation.attempted} · completed: ${evaluation.completed} · failed: ${evaluation.failed} · ` +
    `interrupted: ${evaluation.interrupted} · stale-killed: ${evaluation.staleKilled}` +
    (evaluation.running > 0 ? ` · still-running: ${evaluation.running}` : "") +
    `\n\nAffected jobs:\n${jobLines.join("\n")}\n\n` +
    `_This is a scheduler-wide condition, not a single rotting job. Per-job health alerts may also fire._`
  );
}

export function formatSchedulerRecoveryNotice(
  evaluation: SchedulerZeroSuccessEvaluation,
  incident: SchedulerZeroSuccessIncident,
): string {
  const windowLabel = formatSchedulerWindow(evaluation.windowMs);
  return (
    `:white_check_mark: Scheduler recovered: recurring jobs completed successfully again ` +
    `after a zero-success window that opened ${incident.openedAt}.\n` +
    `Completed in the last ${windowLabel}: ${evaluation.completed} ` +
    `(attempted ${evaluation.attempted}, expected ${evaluation.expected}).`
  );
}

export function parseSchedulerIncident(raw: string | null | undefined): SchedulerZeroSuccessIncident | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SchedulerZeroSuccessIncident>;
    if (typeof parsed.open !== "boolean" || typeof parsed.openedAt !== "string") return null;
    return {
      open: parsed.open,
      openedAt: parsed.openedAt,
      alertedAt: typeof parsed.alertedAt === "string" ? parsed.alertedAt : undefined,
      recoveredAt: typeof parsed.recoveredAt === "string" ? parsed.recoveredAt : undefined,
    };
  } catch {
    return null;
  }
}

async function persistIncident(incident: SchedulerZeroSuccessIncident): Promise<void> {
  await setSetting(
    SCHEDULER_ZERO_SUCCESS_SETTING_KEY,
    JSON.stringify(incident),
    "scheduler-zero-success-monitor",
  );
}

/**
 * Scan enabled recurring jobs for a scheduler-wide zero-success window and
 * send at most one outage (or recovery) ops notice.
 *
 * Never throws — the heartbeat must not fail because of this scan.
 */
export async function scanSchedulerZeroSuccess(now = new Date()): Promise<SchedulerZeroSuccessScanResult> {
  const result: SchedulerZeroSuccessScanResult = { scanned: 0, alerted: 0, recovered: 0 };

  try {
    const windowStart = new Date(now.getTime() - SCHEDULER_ZERO_SUCCESS_WINDOW_MS);
    const notSuspended = or(isNull(jobs.suspendedUntil), lte(jobs.suspendedUntil, now));

    const recurringJobs = await db
      .select({
        id: jobs.id,
        name: jobs.name,
        requestedBy: jobs.requestedBy,
        createdAt: jobs.createdAt,
        cronSchedule: jobs.cronSchedule,
        frequencyConfig: jobs.frequencyConfig,
        timezone: jobs.timezone,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.enabled, 1),
          isNull(jobs.archivedAt),
          notSuspended,
          sql`(${jobs.cronSchedule} IS NOT NULL AND ${jobs.cronSchedule} != '' OR ${jobs.frequencyConfig} IS NOT NULL)`,
        ),
      );

    result.scanned = recurringJobs.length;
    if (recurringJobs.length === 0) {
      logger.info("scheduler_zero_success_scan_skipped_no_recurring_jobs");
      return result;
    }

    const jobIds = recurringJobs.map((job) => job.id);

    const windowExecutions = await db
      .select({
        jobId: jobExecutions.jobId,
        status: jobExecutions.status,
        error: jobExecutions.error,
        startedAt: jobExecutions.startedAt,
        suspendedUntil: jobExecutions.suspendedUntil,
      })
      .from(jobExecutions)
      .where(
        and(inArray(jobExecutions.jobId, jobIds), gte(jobExecutions.startedAt, windowStart)),
      );

    const lastSuccessRows = await db
      .select({
        jobId: jobExecutions.jobId,
        lastSuccessAt: sql<Date>`max(${jobExecutions.startedAt})`.as("last_success_at"),
      })
      .from(jobExecutions)
      .where(and(inArray(jobExecutions.jobId, jobIds), eq(jobExecutions.status, "completed")))
      .groupBy(jobExecutions.jobId);

    const lastSuccessByJob = new Map<string, Date>();
    for (const row of lastSuccessRows) {
      if (!row.jobId || !row.lastSuccessAt) continue;
      lastSuccessByJob.set(row.jobId, row.lastSuccessAt);
    }

    const jobSnapshots: SchedulerJobSnapshot[] = recurringJobs.map((job) => ({
      ...job,
      lastSuccessAt: lastSuccessByJob.get(job.id) ?? null,
    }));

    const evaluation = evaluateSchedulerZeroSuccess({
      jobs: jobSnapshots,
      executions: windowExecutions,
      now,
    });

    const incident = parseSchedulerIncident(
      await getSetting(SCHEDULER_ZERO_SUCCESS_SETTING_KEY),
    );

    if (evaluation.isOutage) {
      if (incident?.open) {
        logger.info("scheduler_zero_success_suppressed", {
          openedAt: incident.openedAt,
          attempted: evaluation.attempted,
          expected: evaluation.expected,
          affectedJobs: evaluation.affectedJobs.length,
        });
        return result;
      }

      const representative = evaluation.affectedJobs[0];
      const noticeResult = await sendJobOpsNotice({
        jobId: representative?.id ?? "scheduler-zero-success",
        jobName: "recurring-job-scheduler",
        requestedBy: representative?.requestedBy ?? "aura",
        text: formatSchedulerOutageNotice(evaluation),
        logContext: {
          event: "scheduler_zero_success_alert",
          expected: evaluation.expected,
          attempted: evaluation.attempted,
          completed: evaluation.completed,
          failed: evaluation.failed,
          interrupted: evaluation.interrupted,
          staleKilled: evaluation.staleKilled,
          affectedJobs: evaluation.affectedJobs.map((job) => job.name),
        },
      });

      if (noticeResult.ok) {
        result.alerted = 1;
        await persistIncident({
          open: true,
          openedAt: now.toISOString(),
          alertedAt: now.toISOString(),
        });
      }

      logger.warn("scheduler_zero_success_alert", {
        noticeSent: noticeResult.ok,
        noticeTarget: noticeResult.target,
        expected: evaluation.expected,
        attempted: evaluation.attempted,
        completed: evaluation.completed,
        failed: evaluation.failed,
        interrupted: evaluation.interrupted,
        staleKilled: evaluation.staleKilled,
        affectedJobCount: evaluation.affectedJobs.length,
      });
      return result;
    }

    if (incident?.open) {
      const representative = jobSnapshots[0];
      const noticeResult = await sendJobOpsNotice({
        jobId: representative?.id ?? "scheduler-zero-success",
        jobName: "recurring-job-scheduler",
        requestedBy: representative?.requestedBy ?? "aura",
        text: formatSchedulerRecoveryNotice(evaluation, incident),
        logContext: {
          event: "scheduler_zero_success_recovery",
          openedAt: incident.openedAt,
          completed: evaluation.completed,
          attempted: evaluation.attempted,
        },
      });

      if (noticeResult.ok) {
        result.recovered = 1;
        await persistIncident({
          open: false,
          openedAt: incident.openedAt,
          alertedAt: incident.alertedAt,
          recoveredAt: now.toISOString(),
        });
      }

      logger.info("scheduler_zero_success_recovery", {
        noticeSent: noticeResult.ok,
        noticeTarget: noticeResult.target,
        openedAt: incident.openedAt,
        completed: evaluation.completed,
      });
    }
  } catch (error: unknown) {
    logger.error("scheduler_zero_success_scan_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}

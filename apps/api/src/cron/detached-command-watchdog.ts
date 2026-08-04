import type { WebClient } from "@slack/web-api";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { detachedCommands, jobExecutions } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { logError } from "../lib/error-logger.js";
import { safePostMessage } from "../lib/slack-messaging.js";

// ── Detached-command watchdog (issue #1281) ──────────────────────────────────
// The detached-command suspend/resume mechanism (#987) relies on a completion
// webhook fired by the sandbox. When that webhook never arrives (sandbox died
// before the curl callback, Vercel SIGKILL, webhook 5xx, ...), the
// detached_commands row stays 'running' forever and — for job executions —
// the job phantom-completes without ever delivering its artifact. This sweep
// runs from the heartbeat cron, mirrors turn-watchdog.ts, and for each stale
// row: (a) writes an error_events row so the loss is observable, (b) marks the
// command failed so check_command reflects reality, (c) fails the linked
// job_executions row if it is still running, and (d) posts one short recovery
// message into the origin thread when there is one.

/** Default staleness threshold before a running command counts as lost. */
const DEFAULT_STALE_MINUTES = 20;

/** Max stale commands processed per sweep. */
const SWEEP_BATCH_SIZE = 20;

export const DETACHED_COMMAND_NEVER_RESUMED_ERROR_CODE =
  "detached_command_never_resumed";

export const DETACHED_COMMAND_RECOVERY_MESSAGE =
  "_That background task didn't report back — re-run or ask me to retry._";

export const DETACHED_COMMAND_WATCHDOG_NOTE =
  "marked failed by watchdog: completion webhook never arrived";

/**
 * Staleness threshold in ms. Tunable via DETACHED_WATCHDOG_STALE_MINUTES
 * (default 20). A legit detached command can run up to the 750s hard max,
 * so 20 min is safely past it plus webhook retry time.
 */
export function detachedCommandWatchdogStaleMs(): number {
  const raw = process.env.DETACHED_WATCHDOG_STALE_MINUTES;
  const parsed = raw ? Number(raw) : NaN;
  const minutes =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_MINUTES;
  return minutes * 60 * 1000;
}

export interface DetachedCommandWatchdogResult {
  /** Stale running commands found by this sweep */
  detected: number;
  /** Commands this sweep claimed + marked failed */
  failed: number;
  /** Linked job_executions rows flipped from running to failed */
  jobExecutionsFailed: number;
  /** Recovery messages posted into origin threads */
  recoveryPosted: number;
}

/**
 * Detect detached commands whose completion webhook never arrived and fail
 * them honestly: error_events row + failed detached_commands row + failed
 * job_executions row (when still running) + one recovery message per command.
 *
 * Dedupe is enforced by an atomic claim: the row is flipped to 'failed' with
 * a `status = 'running'` guard BEFORE any side effect, so a concurrent sweep
 * (or a late webhook racing this sweep) can never double-process.
 *
 * Never throws — the heartbeat must not fail because of the watchdog.
 */
export async function sweepStaleDetachedCommands(
  slackClient: WebClient,
  now = new Date(),
): Promise<DetachedCommandWatchdogResult> {
  const result: DetachedCommandWatchdogResult = {
    detected: 0,
    failed: 0,
    jobExecutionsFailed: 0,
    recoveryPosted: 0,
  };

  try {
    const staleMs = detachedCommandWatchdogStaleMs();
    const cutoff = new Date(now.getTime() - staleMs);

    const staleCommands = await db
      .select()
      .from(detachedCommands)
      .where(
        and(
          eq(detachedCommands.status, "running"),
          lt(detachedCommands.startedAt, cutoff),
        ),
      )
      .orderBy(detachedCommands.startedAt)
      .limit(SWEEP_BATCH_SIZE);

    result.detected = staleCommands.length;

    for (const command of staleCommands) {
      // Atomic claim: only the sweep that flips running → failed gets to
      // process side effects. A late completion webhook also guards on
      // status = 'running', so exactly one of the two wins.
      const claimed = await db
        .update(detachedCommands)
        .set({
          status: "failed",
          completedAt: new Date(),
          stderrTail: DETACHED_COMMAND_WATCHDOG_NOTE,
        })
        .where(
          and(
            eq(detachedCommands.id, command.id),
            eq(detachedCommands.status, "running"),
          ),
        )
        .returning({ id: detachedCommands.id });

      if (claimed.length === 0) continue;

      result.failed++;
      const ageMs = now.getTime() - command.startedAt.getTime();

      logError({
        errorName: "DetachedCommandNeverResumed",
        errorMessage:
          "Detached command completion webhook never arrived — marked failed by watchdog",
        errorCode: DETACHED_COMMAND_NEVER_RESUMED_ERROR_CODE,
        channelId: command.channelId ?? undefined,
        userId: command.requestedBy,
        context: {
          id: command.id,
          command: command.command.slice(0, 100),
          jobId: command.jobId,
          jobExecutionId: command.jobExecutionId,
          threadTs: command.threadTs,
          startedAt: command.startedAt.toISOString(),
          ageMs,
          staleThresholdMs: staleMs,
          recovered_by: "heartbeat",
        },
      });

      // Fail the linked job execution — but ONLY if it is still running.
      // A legitimately completed execution must never be clobbered.
      if (command.jobExecutionId) {
        try {
          const failedExecutions = await db
            .update(jobExecutions)
            .set({
              status: "failed",
              finishedAt: new Date(),
              error: `detached command ${command.id} never resumed (webhook continuation lost)`,
            })
            .where(
              and(
                eq(jobExecutions.id, command.jobExecutionId),
                eq(jobExecutions.status, "running"),
              ),
            )
            .returning({ id: jobExecutions.id });
          result.jobExecutionsFailed += failedExecutions.length;
        } catch (execErr: unknown) {
          logger.warn("detached_watchdog_job_execution_update_failed", {
            id: command.id,
            jobExecutionId: command.jobExecutionId,
            error: execErr instanceof Error ? execErr.message : String(execErr),
          });
        }
      }

      if (command.channelId && command.threadTs) {
        try {
          const postResult = await safePostMessage(slackClient, {
            channel: command.channelId,
            text: DETACHED_COMMAND_RECOVERY_MESSAGE,
            thread_ts: command.threadTs,
          });
          if (postResult.ok) {
            result.recoveryPosted++;
          } else {
            logger.warn("detached_watchdog_recovery_post_failed", {
              id: command.id,
              channelId: command.channelId,
            });
          }
        } catch (postErr: unknown) {
          // Row stays "failed" — one recovery attempt per command, ever.
          logger.warn("detached_watchdog_recovery_post_error", {
            id: command.id,
            channelId: command.channelId,
            error: postErr instanceof Error ? postErr.message : String(postErr),
          });
        }
      }
    }

    if (result.detected > 0) {
      logger.warn("Heartbeat: stale detached command sweep found lost webhooks", {
        detected: result.detected,
        failed: result.failed,
        jobExecutionsFailed: result.jobExecutionsFailed,
        recoveryPosted: result.recoveryPosted,
        staleThresholdMs: staleMs,
      });
    }
  } catch (err: unknown) {
    logger.error("detached_watchdog_sweep_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

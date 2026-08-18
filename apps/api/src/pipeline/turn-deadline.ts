import { db } from "../db/client.js";
import { jobs } from "@aura/db/schema";
import { logger } from "../lib/logger.js";

// ── Turn wall-clock budget (issue #1318) ─────────────────────────────────────
// Vercel kills the function at maxDuration (800s). The step budget never binds
// in practice — turns die around step 40 because sandbox tool calls cost
// 40-150s each — so the loop needs a wall-clock budget too. Two thresholds:
// a soft deadline that nudges the model to wrap up, and a hard deadline that
// withdraws tools so the model is forced to emit a final text message with
// ~80s of headroom before the SIGKILL.

/** Soft deadline default: nudge the model to wrap up (10 min). */
export const TURN_SOFT_DEADLINE_MS = 600_000;

/**
 * Hard deadline default: withdraw tools and force a final message (12 min).
 * Leaves ~80s of headroom before the 800s `maxDuration` SIGKILL for the
 * final model call and Slack delivery.
 */
export const TURN_HARD_DEADLINE_MS = 720_000;

/** Delay before the auto-spawned continuation job becomes eligible to run. */
export const TURN_CONTINUATION_DELAY_MS = 2 * 60_000;

export type TurnDeadlinePath = "interactive" | "headless";

export interface TurnDeadlines {
  softDeadlineMs: number;
  hardDeadlineMs: number;
}

function readDeadlineEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the turn deadlines for a pipeline path. `TURN_SOFT_DEADLINE_MS` /
 * `TURN_HARD_DEADLINE_MS` override the defaults for every path; the headless
 * path can be tuned independently via `HEADLESS_TURN_SOFT_DEADLINE_MS` /
 * `HEADLESS_TURN_HARD_DEADLINE_MS` (falling back to the shared values).
 * Headless jobs run under the same 800s ceiling, so the defaults match.
 */
export function resolveTurnDeadlines(path: TurnDeadlinePath): TurnDeadlines {
  const softDeadlineMs = readDeadlineEnv("TURN_SOFT_DEADLINE_MS", TURN_SOFT_DEADLINE_MS);
  const hardDeadlineMs = readDeadlineEnv("TURN_HARD_DEADLINE_MS", TURN_HARD_DEADLINE_MS);
  if (path === "headless") {
    return {
      softDeadlineMs: readDeadlineEnv("HEADLESS_TURN_SOFT_DEADLINE_MS", softDeadlineMs),
      hardDeadlineMs: readDeadlineEnv("HEADLESS_TURN_HARD_DEADLINE_MS", hardDeadlineMs),
    };
  }
  return { softDeadlineMs, hardDeadlineMs };
}

/**
 * Auto-spawn a continuation job when the hard deadline trips, so the work the
 * turn couldn't finish resumes in the same Slack thread. Reuses the existing
 * `[CONTINUE:topic]` job mechanism (see `checkpoint_plan` in tools/notes.ts
 * and the continuation branch of cron/execute-job.ts) — the heartbeat picks
 * the job up and executeJob routes replies via channelId/threadTs.
 *
 * Fail-soft: returns false on any error so a DB hiccup can never break the
 * final wrap-up step of the turn.
 */
export async function spawnTurnContinuationJob(params: {
  channelId?: string;
  threadTs?: string;
  userId?: string;
  invocationId?: string;
  elapsedMs: number;
  step: number;
}): Promise<boolean> {
  const suffix = (params.invocationId ?? Date.now().toString(36)).slice(0, 8);
  const topic = `turn-deadline-${suffix}`;
  const threadRef = params.threadTs
    ? ` in Slack channel ${params.channelId ?? "unknown"}, thread ${params.threadTs}`
    : params.channelId
      ? ` in Slack channel ${params.channelId}`
      : "";
  const description =
    `[CONTINUE:${topic}] The previous turn${threadRef} hit its wall-clock budget ` +
    `after ${Math.round(params.elapsedMs / 1000)}s (step ${params.step}) and was stopped before finishing. ` +
    `Read the recent messages in that thread to see what was requested and what was already done, ` +
    `then complete the remaining work and post the results in the same thread.`;

  try {
    await db.insert(jobs).values({
      name: `continue-${topic}-${Date.now().toString(36)}`,
      description,
      executeAt: new Date(Date.now() + TURN_CONTINUATION_DELAY_MS),
      channelId: params.channelId || "",
      threadTs: params.threadTs || null,
      requestedBy: params.userId || "aura",
      priority: "high",
    });

    logger.info("turn-deadline: continuation job spawned", {
      topic,
      channelId: params.channelId,
      threadTs: params.threadTs,
      elapsedMs: params.elapsedMs,
      step: params.step,
    });
    return true;
  } catch (err: any) {
    logger.error("turn-deadline: failed to spawn continuation job", {
      topic,
      channelId: params.channelId,
      threadTs: params.threadTs,
      error: err?.message || String(err),
    });
    return false;
  }
}

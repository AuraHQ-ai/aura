import { db } from "../db/client.js";
import { jobs } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { logError } from "../lib/error-logger.js";
import { safePostMessage } from "../lib/slack-messaging.js";

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

/**
 * Max depth of an auto-spawned continuation chain (issue #1320). A
 * continuation job runs headless, gets its own deadlines, and can trip its
 * own hard deadline — without a cap, a task that structurally cannot finish
 * recurs indefinitely. Depth is encoded in the `[CONTINUE:topic:dN]` tag and
 * parsed back in cron/execute-job.ts.
 */
export const MAX_CONTINUATION_DEPTH = 3;

/**
 * Max characters of the truncated assistant message carried into the
 * continuation job description (issue #1336). Long messages keep their TAIL,
 * since the "remaining work" enumeration lands at the end of a cut-off reply.
 */
export const TRUNCATED_MESSAGE_MAX_CHARS = 2000;

/** Posted to the originating thread when the continuation chain hits the cap. */
export const CONTINUATION_DEPTH_EXCEEDED_MESSAGE =
  `I couldn't finish this work within its time budget: it has already been ` +
  `continued ${MAX_CONTINUATION_DEPTH} times and hit the wall-clock limit again, ` +
  `so I'm stopping instead of scheduling another continuation. A human needs to ` +
  `take a look — please re-scope the task or ask me to resume a specific part of it.`;

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
  /**
   * Depth of the continuation being spawned (1 = first continuation of an
   * original turn). Callers resuming a continuation job must pass the parsed
   * depth + 1. Depths past MAX_CONTINUATION_DEPTH are refused: no job is
   * inserted, the originating thread is told a human is needed, and an error
   * event is logged.
   */
  depth?: number;
  /**
   * The partial assistant text the interrupted turn had produced when the
   * hard deadline tripped (issue #1336). Appended verbatim (tail-truncated to
   * TRUNCATED_MESSAGE_MAX_CHARS) to the continuation job description so any
   * promises the model made inside its own cut-off reply ("remaining: rows
   * 41-100, plus the corrected recipe") survive into the continuation instead
   * of being lossily re-derived from the thread history.
   */
  truncatedMessage?: string;
}): Promise<boolean> {
  const depth = params.depth ?? 1;
  const suffix = (params.invocationId ?? Date.now().toString(36)).slice(0, 8);
  const topic = `turn-deadline-${suffix}`;

  if (depth > MAX_CONTINUATION_DEPTH) {
    await notifyContinuationDepthExceeded(topic, depth, params);
    return false;
  }

  const threadRef = params.threadTs
    ? ` in Slack channel ${params.channelId ?? "unknown"}, thread ${params.threadTs}`
    : params.channelId
      ? ` in Slack channel ${params.channelId}`
      : "";
  let description =
    `[CONTINUE:${topic}:d${depth}] The previous turn${threadRef} hit its wall-clock budget ` +
    `after ${Math.round(params.elapsedMs / 1000)}s (step ${params.step}) and was stopped before finishing. ` +
    `Read the recent messages in that thread to see what was requested and what was already done, ` +
    `then complete the remaining work and post the results in the same thread.`;

  const truncatedMessage = params.truncatedMessage?.trim();
  if (truncatedMessage) {
    const tail = truncatedMessage.length > TRUNCATED_MESSAGE_MAX_CHARS
      ? truncatedMessage.slice(-TRUNCATED_MESSAGE_MAX_CHARS)
      : truncatedMessage;
    description +=
      `\n\nYour previous message ended here before being cut off:\n"""\n${tail}\n"""\n` +
      `Anything you stated as remaining or promised for later in that text is still owed — ` +
      `treat it as a checklist and deliver ALL of it, not just what you infer from the thread.`;
  }

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
      depth,
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

/**
 * Depth cap tripped (issue #1320): stop the chain, tell the originating
 * thread a human is needed, and record an error event. Fail-soft like the
 * spawn path — a Slack/DB hiccup must never break the turn's wrap-up step.
 */
async function notifyContinuationDepthExceeded(
  topic: string,
  depth: number,
  params: {
    channelId?: string;
    threadTs?: string;
    userId?: string;
    elapsedMs: number;
    step: number;
  },
): Promise<void> {
  logger.error("turn-deadline: continuation depth cap reached — not spawning", {
    topic,
    depth,
    maxDepth: MAX_CONTINUATION_DEPTH,
    channelId: params.channelId,
    threadTs: params.threadTs,
  });
  logError({
    errorName: "TurnContinuationDepthExceeded",
    errorMessage:
      `Continuation chain for ${topic} reached depth ${depth} ` +
      `(cap ${MAX_CONTINUATION_DEPTH}); refusing to spawn another continuation — a human needs to intervene`,
    errorCode: "turn_continuation_depth_exceeded",
    channelId: params.channelId,
    userId: params.userId,
    context: {
      topic,
      depth,
      maxDepth: MAX_CONTINUATION_DEPTH,
      threadTs: params.threadTs,
      elapsedMs: params.elapsedMs,
      step: params.step,
    },
  });

  if (!params.channelId) return;
  try {
    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(process.env.SLACK_BOT_TOKEN);
    await safePostMessage(client, {
      channel: params.channelId,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
      text: params.userId
        ? `<@${params.userId}> ${CONTINUATION_DEPTH_EXCEEDED_MESSAGE}`
        : CONTINUATION_DEPTH_EXCEEDED_MESSAGE,
    });
  } catch (err: any) {
    logger.error("turn-deadline: failed to notify thread about depth cap", {
      topic,
      channelId: params.channelId,
      error: err?.message || String(err),
    });
  }
}

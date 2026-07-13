import type { WebClient } from "@slack/web-api";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { turnMarkers } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { logError } from "../lib/error-logger.js";
import { safePostMessage } from "../lib/slack-messaging.js";
import { cleanupOldTurnMarkers } from "../lib/turn-markers.js";

// ── Stream-death watchdog (issue #1109) ──────────────────────────────────────
// Vercel hard-kills functions at maxDuration (800s). Every in-process
// protection in the respond pipeline (keepalive, inactivity abort, stream
// splits, postMessage fallbacks, tombstones) executes nothing on a SIGKILL:
// the user sees a message that ends abruptly, with no tombstone and no
// error_events row. This sweep runs from the heartbeat cron — OUTSIDE the
// dead process — and finds turn markers that never reached a terminal state.
// For each stale marker it (a) writes an error_events row so the failure is
// finally observable, (b) posts a short recovery message into the affected
// channel/thread, and (c) marks the marker recovered so it never double-posts.

/** Default staleness threshold before a non-terminal marker counts as killed. */
const DEFAULT_STALE_MINUTES = 15;

/** Max stale markers processed per sweep. */
const SWEEP_BATCH_SIZE = 20;

/** Terminal markers older than this get garbage-collected each sweep. */
const MARKER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const TURN_KILLED_ERROR_CODE = "turn_killed_detected";

export const TURN_RECOVERY_MESSAGE =
  "_That response was cut off by a system limit — ask again and I'll pick it up._";

/**
 * Staleness threshold in ms. Tunable via TURN_WATCHDOG_STALE_MINUTES
 * (default 15). A turn can legitimately run up to maxDuration (800s ≈ 13.3
 * min), so the default sits just past that.
 */
export function turnWatchdogStaleMs(): number {
  const raw = process.env.TURN_WATCHDOG_STALE_MINUTES;
  const parsed = raw ? Number(raw) : NaN;
  const minutes =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_MINUTES;
  return minutes * 60 * 1000;
}

export interface TurnWatchdogResult {
  /** Stale markers found by this sweep */
  detected: number;
  /** Markers this sweep claimed + recovered (error row + recovery message) */
  recovered: number;
}

/**
 * Detect turns whose process died without reaching a terminal state, and
 * recover them: one error_events row + one recovery message per marker, ever.
 *
 * Dedupe is enforced by an atomic claim: the marker is flipped to "recovered"
 * with a `status = 'started'` guard BEFORE any message is posted, so a
 * concurrent sweep (or a rerun) can never double-post. If the Slack post
 * fails after the claim, we deliberately do NOT retry on later sweeps —
 * strictly one recovery attempt per marker.
 *
 * Never throws — the heartbeat must not fail because of the watchdog.
 */
export async function sweepStaleTurnMarkers(
  slackClient: WebClient,
  now = new Date(),
): Promise<TurnWatchdogResult> {
  const result: TurnWatchdogResult = { detected: 0, recovered: 0 };

  try {
    const staleMs = turnWatchdogStaleMs();
    const cutoff = new Date(now.getTime() - staleMs);

    const staleMarkers = await db
      .select()
      .from(turnMarkers)
      .where(
        and(
          eq(turnMarkers.status, "started"),
          lt(turnMarkers.startedAt, cutoff),
        ),
      )
      .orderBy(turnMarkers.startedAt)
      .limit(SWEEP_BATCH_SIZE);

    result.detected = staleMarkers.length;

    for (const marker of staleMarkers) {
      // Atomic claim: only the sweep that flips started → recovered gets to
      // post. Guarantees one recovery message per marker, ever.
      const claimed = await db
        .update(turnMarkers)
        .set({ status: "recovered", endedAt: new Date() })
        .where(
          and(
            eq(turnMarkers.id, marker.id),
            eq(turnMarkers.status, "started"),
          ),
        )
        .returning({ id: turnMarkers.id });

      if (claimed.length === 0) continue;

      result.recovered++;
      const ageMs = now.getTime() - marker.startedAt.getTime();

      logError({
        errorName: "TurnKilledDetected",
        errorMessage:
          "Turn never reached a terminal state — process was likely hard-killed (Vercel maxDuration)",
        errorCode: TURN_KILLED_ERROR_CODE,
        channelId: marker.channelId,
        userId: marker.userId ?? undefined,
        context: {
          invocationId: marker.invocationId,
          threadTs: marker.threadTs,
          messageTs: marker.messageTs,
          startedAt: marker.startedAt.toISOString(),
          ageMs,
          staleThresholdMs: staleMs,
          recovered_by: "heartbeat",
        },
      });

      try {
        const postResult = await safePostMessage(slackClient, {
          channel: marker.channelId,
          text: TURN_RECOVERY_MESSAGE,
          ...(marker.threadTs && { thread_ts: marker.threadTs }),
        });
        if (!postResult.ok) {
          logger.warn("turn_watchdog_recovery_post_failed", {
            invocationId: marker.invocationId,
            channelId: marker.channelId,
          });
        }
      } catch (postErr: unknown) {
        // Marker stays "recovered" — one recovery attempt per marker, ever.
        logger.warn("turn_watchdog_recovery_post_error", {
          invocationId: marker.invocationId,
          channelId: marker.channelId,
          error: postErr instanceof Error ? postErr.message : String(postErr),
        });
      }
    }

    // Garbage-collect old terminal markers so the table stays small.
    await cleanupOldTurnMarkers(new Date(now.getTime() - MARKER_RETENTION_MS));

    if (result.detected > 0) {
      logger.warn("Heartbeat: stale turn marker sweep found killed turns", {
        detected: result.detected,
        recovered: result.recovered,
        staleThresholdMs: staleMs,
      });
    }
  } catch (err: unknown) {
    logger.error("turn_watchdog_sweep_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

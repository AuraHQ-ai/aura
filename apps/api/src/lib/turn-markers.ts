import { and, eq, lt, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { turnMarkers } from "@aura/db/schema";
import { logger } from "./logger.js";

// ── Turn Markers (stream-death watchdog, issue #1109) ────────────────────────
// A marker row is the ground truth that a Slack respond turn started. Every
// in-process exit path marks it terminal; a row stuck in "started" means the
// process was hard-killed (Vercel maxDuration SIGKILL) and none of the
// in-process fallbacks ran. The heartbeat watchdog (cron/turn-watchdog.ts)
// detects those rows and posts a recovery message from outside the dead
// process.
//
// All writes here are fail-soft by design: a marker failure must NEVER break
// the actual response path.

export type TurnMarkerTerminalStatus = "completed" | "failed";

export interface StartTurnMarkerParams {
  invocationId: string;
  channelId: string;
  threadTs?: string;
  /** ts of the user message this turn is responding to */
  messageTs?: string;
  userId?: string;
  workspaceId?: string;
}

/**
 * Record that a turn started. Fail-soft: logs a warning and returns on any
 * DB error. Idempotent per invocation (conflict on invocation id is a no-op).
 */
export async function startTurnMarker(params: StartTurnMarkerParams): Promise<void> {
  try {
    await db
      .insert(turnMarkers)
      .values({
        workspaceId: params.workspaceId ?? "default",
        invocationId: params.invocationId,
        channelId: params.channelId,
        threadTs: params.threadTs,
        messageTs: params.messageTs,
        userId: params.userId,
      })
      .onConflictDoNothing();
  } catch (err: unknown) {
    logger.warn("turn_marker_start_failed", {
      invocationId: params.invocationId,
      channelId: params.channelId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Mark a turn terminal (completed/failed). Only transitions rows still in
 * "started" so the first terminal write wins and a recovered marker is never
 * overwritten. Fail-soft: never throws.
 */
export async function finishTurnMarker(
  invocationId: string,
  status: TurnMarkerTerminalStatus,
): Promise<void> {
  try {
    await db
      .update(turnMarkers)
      .set({ status, endedAt: new Date() })
      .where(
        and(
          eq(turnMarkers.invocationId, invocationId),
          eq(turnMarkers.status, "started"),
        ),
      );
  } catch (err: unknown) {
    logger.warn("turn_marker_finish_failed", {
      invocationId,
      status,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Delete terminal markers older than the cutoff so the table doesn't grow
 * unbounded. Rows still in "started" are kept for the watchdog. Fail-soft.
 */
export async function cleanupOldTurnMarkers(cutoff: Date): Promise<number> {
  try {
    const deleted = await db
      .delete(turnMarkers)
      .where(
        and(
          ne(turnMarkers.status, "started"),
          lt(turnMarkers.startedAt, cutoff),
        ),
      )
      .returning({ id: turnMarkers.id });
    return deleted.length;
  } catch (err: unknown) {
    logger.warn("turn_marker_cleanup_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

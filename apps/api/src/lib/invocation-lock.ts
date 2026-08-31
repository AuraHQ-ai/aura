import { eq, and, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { conversationLocks } from "@aura/db/schema";
import { logger } from "./logger.js";

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_PROBABILITY = 0.05;

/**
 * Claim an invocation for a conversation. Returns the invocation ID,
 * or `null` if the claim was a no-op (a newer message already holds the lock).
 *
 * Uses Slack's message_ts for ordering so that a late-arriving cold-start
 * for an older message can never overwrite a newer message's claim.
 * The UPDATE only fires when the incoming message_ts is strictly greater
 * than the stored one.
 */
export async function claimInvocation(
  channelId: string,
  threadTs: string,
  messageTs: string,
  workspaceId: string = "default",
): Promise<string | null> {
  const invocationId = crypto.randomUUID();

  const result = await db.execute(sql`
    INSERT INTO conversation_locks (workspace_id, channel_id, thread_ts, invocation_id, message_ts, started_at)
    VALUES (${workspaceId}, ${channelId}, ${threadTs}, ${invocationId}, ${messageTs}, now())
    ON CONFLICT (workspace_id, channel_id, thread_ts) DO UPDATE
      SET invocation_id = ${invocationId},
          message_ts    = ${messageTs},
          started_at    = now()
      WHERE conversation_locks.message_ts < ${messageTs}
    RETURNING invocation_id
  `);

  const rowCount = (result as any).rowCount ?? (result as any).rows?.length ?? 0;
  if (rowCount === 0) {
    logger.info("Invocation claim rejected — newer message already holds lock", {
      channelId, threadTs, messageTs, invocationId,
    });
    return null;
  }

  logger.info("Claimed invocation lock", { channelId, threadTs, messageTs, invocationId });

  if (Math.random() < CLEANUP_PROBABILITY) {
    cleanupStaleLocks().catch((err) => {
      logger.warn("Failed to cleanup stale conversation locks", { error: err?.message });
    });
  }

  return invocationId;
}

async function cleanupStaleLocks(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const result = await db
    .delete(conversationLocks)
    .where(lt(conversationLocks.startedAt, cutoff));
  const count = (result as any).rowCount ?? (result as any).count ?? 0;
  if (count > 0) {
    logger.info("Cleaned up stale conversation locks", { deleted: count });
  }
}

/**
 * Invocation ids written by `stopInvocation()` carry this prefix so the
 * running turn can tell "the user pressed Stop" apart from "a newer message
 * arrived" when it discovers it is no longer current.
 */
export const STOP_INVOCATION_PREFIX = "stop:";

export type SupersedeReason = "stopped" | "newer_message";

/**
 * Stop whatever turn is running for a conversation (Slack `agent_session_stopped`).
 *
 * Overwrites the lock's `invocation_id` with a `stop:` sentinel WITHOUT
 * advancing `message_ts`, so:
 *   - every in-flight invocation for the thread fails its next
 *     `isInvocationCurrent()` check (in-process: next prepareStep; durable
 *     workflow: next step) and unwinds through the superseded path;
 *   - the user's next message still claims the lock normally (its ts is newer).
 * If no lock exists there is nothing running; the sentinel is still written
 * so a cold-start straggler for an older message cannot resurrect the turn.
 *
 * Returns true when a live invocation was actually displaced.
 */
export async function stopInvocation(
  channelId: string,
  threadTs: string,
  eventTs: string,
  workspaceId: string = "default",
): Promise<boolean> {
  const stopId = `${STOP_INVOCATION_PREFIX}${crypto.randomUUID()}`;
  const result = await db.execute(sql`
    INSERT INTO conversation_locks (workspace_id, channel_id, thread_ts, invocation_id, message_ts, started_at)
    VALUES (${workspaceId}, ${channelId}, ${threadTs}, ${stopId}, ${eventTs}, now())
    ON CONFLICT (workspace_id, channel_id, thread_ts) DO UPDATE
      SET invocation_id = ${stopId},
          started_at    = now()
    RETURNING (xmax <> 0) AS displaced, invocation_id
  `);
  const rows = ((result as any).rows ?? []) as Array<{ displaced?: boolean }>;
  const displaced = rows[0]?.displaced === true;
  logger.info("Stop requested for conversation", { channelId, threadTs, displaced, stopId });
  return displaced;
}

/**
 * Why the current lock holder is not `invocationId` — used to word the
 * interruption note ("stopped" vs "a newer message arrived").
 */
export async function getSupersedeReason(
  channelId: string,
  threadTs: string,
): Promise<SupersedeReason> {
  try {
    const rows = await db
      .select({ invocationId: conversationLocks.invocationId })
      .from(conversationLocks)
      .where(
        and(
          eq(conversationLocks.channelId, channelId),
          eq(conversationLocks.threadTs, threadTs),
        ),
      )
      .limit(1);
    if (rows[0]?.invocationId?.startsWith(STOP_INVOCATION_PREFIX)) return "stopped";
  } catch {
    // fall through — default wording
  }
  return "newer_message";
}

export function interruptionNote(reason: SupersedeReason): string {
  return reason === "stopped" ? "_[stopped]_" : "_[interrupted — new message received]_";
}

/**
 * Check if this invocation is still the current one.
 * Returns true if still current, false if superseded.
 */
export async function isInvocationCurrent(
  channelId: string,
  threadTs: string,
  invocationId: string,
): Promise<boolean> {
  const result = await db
    .select({ invocationId: conversationLocks.invocationId })
    .from(conversationLocks)
    .where(
      and(
        eq(conversationLocks.channelId, channelId),
        eq(conversationLocks.threadTs, threadTs),
      ),
    )
    .limit(1);

  if (result.length === 0) return true;
  return result[0].invocationId === invocationId;
}

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
): Promise<string | null> {
  const invocationId = crypto.randomUUID();

  const result = await db.execute(sql`
    INSERT INTO conversation_locks (channel_id, thread_ts, invocation_id, message_ts, started_at)
    VALUES (${channelId}, ${threadTs}, ${invocationId}, ${messageTs}, now())
    ON CONFLICT (channel_id, thread_ts) DO UPDATE
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

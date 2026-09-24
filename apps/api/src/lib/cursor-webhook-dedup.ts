import { and, eq } from "drizzle-orm";
import { eventLocks } from "@aura/db/schema";
import { db } from "../db/client.js";
import { logger } from "./logger.js";

/**
 * Synthetic "channel" for Cursor webhook rows in `event_locks`, whose unique
 * index is (workspace_id, event_ts, channel_id). Keeps these locks in their own
 * namespace so they can never collide with Slack event locks.
 */
export const CURSOR_WEBHOOK_LOCK_CHANNEL = "cursor-agent-webhook";

/**
 * Cursor emits more than one terminal event per agent run — "finished" and
 * "completed" both mean "done" — and redelivers whenever it is unsure the
 * webhook landed. Collapsing on the raw status or on the per-delivery
 * `x-webhook-id` therefore does not dedup anything: each delivery looks new.
 *
 * The stable identity of a notification is (agent, outcome), so that is the
 * lock key. `x-webhook-id` is only a fallback for payloads that carry no
 * agent id.
 */
function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "finished" || s === "completed") return "finished";
  if (s === "error" || s === "failed") return "error";
  return s || "unknown";
}

export function cursorWebhookLockKey(
  agentId: string,
  status: string,
  webhookId: string,
): string {
  if (agentId) return `cursor-agent:${agentId}:${statusClass(status)}`;
  if (webhookId) return `cursor-webhook:${webhookId}`;
  return "";
}

/**
 * Returns true if this delivery should be processed, false if an earlier
 * delivery already claimed it.
 *
 * Fails open: if the lock table is unreachable we process the webhook. A
 * duplicate Slack message is a far cheaper failure than a silently dropped
 * agent notification.
 */
export async function claimCursorWebhook(key: string): Promise<boolean> {
  if (!key) return true;

  try {
    const result = await db
      .insert(eventLocks)
      .values({ eventTs: key, channelId: CURSOR_WEBHOOK_LOCK_CHANNEL })
      .onConflictDoNothing()
      .returning({ id: eventLocks.id });
    return result.length > 0;
  } catch (error) {
    logger.warn("Cursor webhook dedup: claim failed, processing anyway", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

/**
 * Drop a single claimed lock by key.
 *
 * Used when processing failed after the claim: keeping the lock would turn a
 * transient failure into a permanently lost notification, because Cursor's
 * redelivery would be skipped as a duplicate.
 */
export async function releaseCursorWebhookClaim(key: string): Promise<void> {
  if (!key) return;

  try {
    await db
      .delete(eventLocks)
      .where(
        and(
          eq(eventLocks.eventTs, key),
          eq(eventLocks.channelId, CURSOR_WEBHOOK_LOCK_CHANNEL),
        ),
      );
  } catch (error) {
    logger.warn("Cursor webhook dedup: failed to release claim", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Release an agent's terminal locks.
 *
 * A follow-up restarts a finished agent, which will emit "finished" again for
 * the *new* run. Without this the (agent, outcome) lock from the first run
 * would suppress that notification forever — trading duplicate messages for
 * missing ones. Called from the follow-up path, never from the webhook.
 */
export async function releaseCursorWebhookLocks(
  agentId: string,
): Promise<void> {
  if (!agentId) return;

  for (const outcome of ["finished", "error"]) {
    try {
      await db
        .delete(eventLocks)
        .where(
          and(
            eq(eventLocks.eventTs, `cursor-agent:${agentId}:${outcome}`),
            eq(eventLocks.channelId, CURSOR_WEBHOOK_LOCK_CHANNEL),
          ),
        );
    } catch (error) {
      logger.warn("Cursor webhook dedup: failed to release lock", {
        agentId,
        outcome,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { conversationLocks } from "@aura/db/schema";
import { logger } from "./logger.js";

/**
 * Claim an invocation for a conversation. Returns the invocation ID.
 * If another invocation is already running, it gets superseded.
 */
export async function claimInvocation(channelId: string, threadTs: string): Promise<string> {
  const invocationId = crypto.randomUUID();
  await db
    .insert(conversationLocks)
    .values({ channelId, threadTs, invocationId })
    .onConflictDoUpdate({
      target: [conversationLocks.channelId, conversationLocks.threadTs],
      set: { invocationId, startedAt: new Date() },
    });
  logger.info("Claimed invocation lock", { channelId, threadTs, invocationId });
  return invocationId;
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

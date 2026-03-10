import type { WebClient } from "@slack/web-api";
import { eq, and, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { pendingApprovals } from "../db/schema.js";
import { logger } from "./logger.js";

// ── Constants ───────────────────────────────────────────────────────────────

const TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Persist a pending approval to the database and return its ID.
 * The approval can be resolved later (possibly in a different Vercel isolate)
 * via resolveApproval().
 */
export async function createPendingApproval(opts: {
  toolName: string;
  toolCallId: string;
  args: unknown;
  channelId: string;
  threadTs?: string;
  userId: string;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(pendingApprovals)
    .values({
      toolName: opts.toolName,
      toolCallId: opts.toolCallId,
      args: opts.args as any,
      channelId: opts.channelId,
      threadTs: opts.threadTs ?? null,
      userId: opts.userId,
      status: "pending",
    })
    .returning({ id: pendingApprovals.id });

  return { id: row.id };
}

/**
 * Resolve a pending approval. Returns the row if found and still pending,
 * null otherwise. Updates the row atomically so double-clicks are safe.
 */
export async function resolveApproval(
  approvalId: string,
  approved: boolean,
  resolvedBy: string,
): Promise<typeof pendingApprovals.$inferSelect | null> {
  const newStatus = approved ? "approved" : "rejected";

  const [updated] = await db
    .update(pendingApprovals)
    .set({
      status: newStatus,
      resolvedBy,
      resolvedAt: new Date(),
    })
    .where(
      and(
        eq(pendingApprovals.id, approvalId),
        eq(pendingApprovals.status, "pending"),
      ),
    )
    .returning();

  if (!updated) {
    logger.info("resolveApproval: not found or already resolved", { approvalId });
    return null;
  }

  return updated;
}

/**
 * Look up a pending approval by ID without resolving it.
 */
export async function getPendingApproval(
  approvalId: string,
): Promise<typeof pendingApprovals.$inferSelect | null> {
  const rows = await db
    .select()
    .from(pendingApprovals)
    .where(eq(pendingApprovals.id, approvalId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Expire stale approvals that have exceeded the TTL. Called from heartbeat
 * or lazily. Not critical — buttons simply become no-ops once the row
 * is resolved/expired.
 */
export async function expireStaleApprovals(): Promise<number> {
  const cutoff = new Date(Date.now() - TTL_MS);
  const expired = await db
    .update(pendingApprovals)
    .set({ status: "expired" })
    .where(
      and(
        eq(pendingApprovals.status, "pending"),
        lt(pendingApprovals.createdAt, cutoff),
      ),
    )
    .returning({ id: pendingApprovals.id });

  if (expired.length > 0) {
    logger.info("Expired stale HITL approvals", { count: expired.length });
  }
  return expired.length;
}

// ── Slack UI ────────────────────────────────────────────────────────────────

/**
 * Post an approval request message with Approve / Reject buttons.
 */
export async function postApprovalMessage(
  slackClient: WebClient,
  approval: {
    id: string;
    toolName: string;
    args: unknown;
    channelId: string;
    threadTs?: string | null;
    userId: string;
  },
): Promise<void> {
  const paramsSummary = JSON.stringify(approval.args, null, 2);
  const truncatedParams =
    paramsSummary.length > 2800
      ? paramsSummary.slice(0, 2800) + "\n... (truncated)"
      : paramsSummary;

  const blocks = [
    {
      type: "header" as const,
      text: {
        type: "plain_text" as const,
        text: `Approval Required: ${approval.toolName}`,
        emoji: true,
      },
    },
    {
      type: "section" as const,
      text: {
        type: "mrkdwn" as const,
        text: `*Requested by:* <@${approval.userId}>`,
      },
    },
    {
      type: "section" as const,
      text: {
        type: "mrkdwn" as const,
        text: `*Parameters:*\n\`\`\`${truncatedParams}\`\`\``,
      },
    },
    {
      type: "actions" as const,
      elements: [
        {
          type: "button" as const,
          text: { type: "plain_text" as const, text: "Approve", emoji: true },
          style: "primary" as const,
          action_id: `hitl_approve_${approval.id}`,
          value: approval.id,
        },
        {
          type: "button" as const,
          text: { type: "plain_text" as const, text: "Reject", emoji: true },
          style: "danger" as const,
          action_id: `hitl_reject_${approval.id}`,
          value: approval.id,
        },
      ],
    },
    {
      type: "context" as const,
      elements: [
        {
          type: "mrkdwn" as const,
          text: `\`approval_id: ${approval.id}\` • expires in 10 minutes`,
        },
      ],
    },
  ];

  await slackClient.chat.postMessage({
    channel: approval.channelId,
    ...(approval.threadTs ? { thread_ts: approval.threadTs } : {}),
    text: `Approval required for ${approval.toolName}`,
    blocks,
  });

  logger.info("HITL approval message posted", {
    approvalId: approval.id,
    toolName: approval.toolName,
    channel: approval.channelId,
  });
}

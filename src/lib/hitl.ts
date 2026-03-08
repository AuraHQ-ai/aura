import crypto from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface PendingApproval {
  id: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
  channelId: string;
  threadTs?: string;
  userId: string;
  createdAt: number;
  resolve: (approved: boolean) => void;
}

// ── In-memory Store ─────────────────────────────────────────────────────────

const pending = new Map<string, PendingApproval>();

const TTL_MS = 10 * 60 * 1000; // 10 minutes

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.createdAt + TTL_MS < now) {
      entry.resolve(false);
      pending.delete(id);
    }
  }
}, 60_000);
cleanupInterval.unref();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Register a pending approval and return a promise that resolves when the
 * human clicks Approve (true) or Reject (false). The promise also rejects
 * after TTL_MS via the cleanup interval.
 */
export function createPendingApproval(opts: {
  toolName: string;
  toolCallId: string;
  args: unknown;
  channelId: string;
  threadTs?: string;
  userId: string;
}): { id: string; promise: Promise<boolean> } {
  const id = crypto.randomBytes(12).toString("hex");

  let resolveRef!: (approved: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolveRef = resolve;
  });

  pending.set(id, {
    id,
    toolName: opts.toolName,
    toolCallId: opts.toolCallId,
    args: opts.args,
    channelId: opts.channelId,
    threadTs: opts.threadTs,
    userId: opts.userId,
    createdAt: Date.now(),
    resolve: resolveRef,
  });

  return { id, promise };
}

/**
 * Resolve a pending approval. Returns the entry if found, null otherwise.
 */
export function resolveApproval(
  approvalId: string,
  approved: boolean,
): PendingApproval | null {
  const entry = pending.get(approvalId);
  if (!entry) return null;
  pending.delete(approvalId);
  if (entry.createdAt + TTL_MS < Date.now()) {
    entry.resolve(false);
    return null;
  }
  entry.resolve(approved);
  return entry;
}

/**
 * Look up a pending approval without resolving it.
 */
export function getPendingApproval(
  approvalId: string,
): PendingApproval | null {
  return pending.get(approvalId) ?? null;
}

// ── Slack UI ────────────────────────────────────────────────────────────────

/**
 * Post an approval request message with Approve / Reject buttons.
 */
export async function postApprovalMessage(
  slackClient: WebClient,
  approval: PendingApproval,
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

  const targetChannel = approval.channelId;

  await slackClient.chat.postMessage({
    channel: targetChannel,
    ...(approval.threadTs ? { thread_ts: approval.threadTs } : {}),
    text: `Approval required for ${approval.toolName}`,
    blocks,
  });

  logger.info("HITL approval message posted", {
    approvalId: approval.id,
    toolName: approval.toolName,
    channel: targetChannel,
  });
}

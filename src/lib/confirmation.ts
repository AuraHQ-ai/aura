/**
 * Interactive confirmation for destructive operations.
 *
 * In-memory pending-confirmation map with 5-minute TTL.
 * Used to gate write/destructive credential operations behind
 * a Slack button confirmation flow.
 */
import crypto from "node:crypto";
import { logger } from "./logger.js";

interface PendingConfirmation {
  token: string;
  userId: string;
  action: string;
  context: Record<string, unknown>;
  createdAt: number;
  resolve: (approved: boolean) => void;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const pending = new Map<string, PendingConfirmation>();

// Periodic cleanup of expired tokens
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pending) {
    if (now - entry.createdAt > TTL_MS) {
      entry.resolve(false);
      pending.delete(token);
    }
  }
}, 60_000);

/**
 * Request confirmation for a destructive operation.
 * Returns a token and Slack blocks for the confirmation message.
 * The returned promise resolves when the user clicks approve/deny.
 */
export function requestConfirmation(
  userId: string,
  action: string,
  context: Record<string, unknown> = {},
): {
  token: string;
  blocks: any[];
  promise: Promise<boolean>;
} {
  const token = crypto.randomBytes(16).toString("hex");

  let resolveRef: (approved: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolveRef = resolve;
  });

  pending.set(token, {
    token,
    userId,
    action,
    context,
    createdAt: Date.now(),
    resolve: resolveRef!,
  });

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⚠️ *Confirmation required*\n${action}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Approve" },
          style: "primary",
          action_id: `confirm_approve_${token}`,
          value: token,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ Deny" },
          style: "danger",
          action_id: `confirm_deny_${token}`,
          value: token,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_This confirmation expires in 5 minutes._`,
        },
      ],
    },
  ];

  logger.info("Confirmation requested", { token, userId, action });

  return { token, blocks, promise };
}

/**
 * Resolve a pending confirmation (called from Slack action handler).
 * Returns true if the token was valid and resolved, false if expired/unknown.
 */
export function resolveConfirmation(
  token: string,
  approved: boolean,
  respondingUserId: string,
): boolean {
  const entry = pending.get(token);
  if (!entry) {
    logger.warn("Confirmation token not found or expired", { token });
    return false;
  }

  if (entry.userId !== respondingUserId) {
    logger.warn("Confirmation responded by wrong user", {
      token,
      expected: entry.userId,
      actual: respondingUserId,
    });
    return false;
  }

  entry.resolve(approved);
  pending.delete(token);

  logger.info("Confirmation resolved", {
    token,
    approved,
    userId: respondingUserId,
    action: entry.action,
  });

  return true;
}

/**
 * Check if a token exists and is still valid (for UI updates).
 */
export function isConfirmationPending(token: string): boolean {
  const entry = pending.get(token);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > TTL_MS) {
    pending.delete(token);
    return false;
  }
  return true;
}

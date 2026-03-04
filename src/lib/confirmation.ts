import crypto from "node:crypto";
import type { WebClient } from "@slack/web-api";

interface PendingConfirmation {
  action: string;
  credentialId: string;
  userId: string;
  expiresAt: number;
}

const pending = new Map<string, PendingConfirmation>();

const TTL_MS = 5 * 60 * 1000;

// Cleanup expired confirmations every 60s
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pending) {
    if (entry.expiresAt < now) pending.delete(token);
  }
}, 60_000);
cleanupInterval.unref();

export async function requestConfirmation(
  client: WebClient,
  channelId: string,
  userId: string,
  action: string,
  credentialId: string,
): Promise<string> {
  const token = crypto.randomBytes(16).toString("hex");
  pending.set(token, {
    action,
    credentialId,
    userId,
    expiresAt: Date.now() + TTL_MS,
  });

  await client.chat.postMessage({
    channel: channelId,
    text: `Confirm destructive action: ${action}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Confirmation required*\n${action}\n\n_This request expires in 5 minutes._`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            action_id: `confirm_approve_${token}`,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Deny" },
            style: "danger",
            action_id: `confirm_deny_${token}`,
          },
        ],
      },
    ],
  });

  return token;
}

export function resolveConfirmation(
  token: string,
): PendingConfirmation | null {
  const entry = pending.get(token);
  if (!entry) return null;
  pending.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

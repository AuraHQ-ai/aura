import crypto from "node:crypto";

interface PendingConfirmation {
  token: string;
  userId: string;
  action: string;
  context: Record<string, unknown>;
  createdAt: number;
  resolve: (approved: boolean) => void;
}

const pending = new Map<string, PendingConfirmation>();

const TTL_MS = 5 * 60 * 1000;

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pending) {
    if (entry.createdAt + TTL_MS < now) {
      entry.resolve(false);
      pending.delete(token);
    }
  }
}, 60_000);
cleanupInterval.unref();

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
  ];

  return { token, blocks, promise };
}

export function resolveConfirmation(
  token: string,
  approved: boolean = false,
): PendingConfirmation | null {
  const entry = pending.get(token);
  if (!entry) return null;
  pending.delete(token);
  if (entry.createdAt + TTL_MS < Date.now()) {
    entry.resolve(false);
    return null;
  }
  entry.resolve(approved);
  return entry;
}

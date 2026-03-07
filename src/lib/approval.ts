/**
 * Action governance: approval flow, policy lookup, action logging, and secret scrubbing.
 *
 * Destructive tools require human approval via Slack reactions before execution.
 * Write tools are executed immediately but logged. Read tools are optionally logged.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  actionLog,
  approvalPolicies,
  type ApprovalPolicy,
  type ActionLogEntry,
} from "../db/schema.js";
import { isAdmin } from "./permissions.js";
import { logger } from "./logger.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type RiskTier = "read" | "write" | "destructive";
export type ActionStatus =
  | "executed"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "failed";

export interface ActionLogInput {
  toolName: string;
  params: Record<string, unknown>;
  result?: Record<string, unknown>;
  status: ActionStatus;
  riskTier: RiskTier;
  triggerType?: string;
  triggeredBy: string;
  credentialId?: string;
  approvalMessageTs?: string;
  approvalChannel?: string;
  approvedBy?: string;
  approvedAt?: Date;
}

// ── Secret Scrubbing ───────────────────────────────────────────────────────

const SENSITIVE_FIELD_PATTERN =
  /token|key|secret|password|credential|authorization/i;

export function scrubSecrets(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_FIELD_PATTERN.test(key)) {
      scrubbed[key] = "[REDACTED]";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      scrubbed[key] = scrubSecrets(value as Record<string, unknown>);
    } else {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

// ── Action Log ─────────────────────────────────────────────────────────────

export async function writeActionLog(
  input: ActionLogInput,
): Promise<ActionLogEntry> {
  const scrubbedParams = scrubSecrets(input.params);
  const [row] = await db
    .insert(actionLog)
    .values({
      toolName: input.toolName,
      params: scrubbedParams,
      result: input.result ?? null,
      status: input.status,
      riskTier: input.riskTier,
      triggerType: input.triggerType ?? "interactive",
      triggeredBy: input.triggeredBy,
      credentialId: input.credentialId ?? null,
      approvalMessageTs: input.approvalMessageTs ?? null,
      approvalChannel: input.approvalChannel ?? null,
      approvedBy: input.approvedBy ?? null,
      approvedAt: input.approvedAt ?? null,
    })
    .returning();
  return row;
}

export async function updateActionLog(
  id: string,
  updates: Partial<
    Pick<
      ActionLogEntry,
      | "status"
      | "result"
      | "approvedBy"
      | "approvedAt"
      | "approvalMessageTs"
      | "approvalChannel"
    >
  >,
): Promise<void> {
  await db.update(actionLog).set(updates).where(eq(actionLog.id, id));
}

export async function getActionLogEntry(
  id: string,
): Promise<ActionLogEntry | null> {
  const rows = await db
    .select()
    .from(actionLog)
    .where(eq(actionLog.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// ── Policy Lookup ──────────────────────────────────────────────────────────

export async function getApprovalPolicy(
  toolName: string,
): Promise<ApprovalPolicy | null> {
  const rows = await db
    .select()
    .from(approvalPolicies)
    .where(eq(approvalPolicies.toolPattern, toolName))
    .limit(1);
  return rows[0] ?? null;
}

export function resolveRiskTier(
  toolRisk: RiskTier,
  policy: ApprovalPolicy | null,
): RiskTier {
  if (policy?.riskTierOverride) {
    return policy.riskTierOverride;
  }
  return toolRisk;
}

export function getApproverIds(policy: ApprovalPolicy | null): string[] {
  if (policy?.approverIds && policy.approverIds.length > 0) {
    return policy.approverIds;
  }
  const adminIds = (process.env.AURA_ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return adminIds;
}

export function getApprovalChannel(policy: ApprovalPolicy | null): string {
  if (policy?.approvalChannel) {
    return policy.approvalChannel;
  }
  return process.env.AURA_APPROVAL_CHANNEL || "";
}

// ── Approval Policy Management (admin-only) ───────────────────────────────

export async function upsertApprovalPolicy(
  userId: string,
  toolPattern: string,
  updates: {
    riskTierOverride?: RiskTier;
    approverIds?: string[];
    approvalChannel?: string;
  },
): Promise<{ ok: true; policy: ApprovalPolicy } | { ok: false; error: string }> {
  if (!isAdmin(userId)) {
    return { ok: false, error: "Only admins can modify approval policies" };
  }

  const [row] = await db
    .insert(approvalPolicies)
    .values({
      toolPattern,
      riskTierOverride: updates.riskTierOverride ?? null,
      approverIds: updates.approverIds ?? [],
      approvalChannel: updates.approvalChannel ?? null,
      createdBy: userId,
    })
    .onConflictDoUpdate({
      target: approvalPolicies.toolPattern,
      set: {
        riskTierOverride: updates.riskTierOverride ?? null,
        approverIds: updates.approverIds ?? [],
        approvalChannel: updates.approvalChannel ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  return { ok: true, policy: row };
}

// ── Slack Approval Message ─────────────────────────────────────────────────

export function buildApprovalMessage(
  actionLogId: string,
  toolName: string,
  params: Record<string, unknown>,
  triggeredBy: string,
): { text: string; blocks: any[] } {
  const scrubbedParams = scrubSecrets(params);
  const paramSummary = Object.entries(scrubbedParams)
    .slice(0, 8)
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      const truncated = val && val.length > 100 ? val.slice(0, 97) + "..." : val;
      return `• *${k}*: ${truncated}`;
    })
    .join("\n");

  const text = `🔒 *Approval required* for \`${toolName}\`\nRequested by <@${triggeredBy}>\n\n${paramSummary}\n\nReact with ✅ to approve or ❌ to reject.`;

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🔒 *Approval required* for \`${toolName}\``,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Requested by <@${triggeredBy}> • Action ID: \`${actionLogId}\``,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: paramSummary || "_No parameters_",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "React with ✅ to approve or ❌ to reject.",
        },
      ],
    },
  ];

  return { text, blocks };
}

// ── Reaction Handler ───────────────────────────────────────────────────────

export async function handleApprovalReaction(opts: {
  reaction: string;
  userId: string;
  channelId: string;
  messageTs: string;
}): Promise<{ handled: boolean; action?: "approved" | "rejected" }> {
  const { reaction, userId, channelId, messageTs } = opts;

  const isApprove =
    reaction === "white_check_mark" || reaction === "heavy_check_mark";
  const isReject = reaction === "x" || reaction === "no_entry_sign";

  if (!isApprove && !isReject) {
    return { handled: false };
  }

  const rows = await db
    .select()
    .from(actionLog)
    .where(eq(actionLog.approvalMessageTs, messageTs))
    .limit(1);

  const entry = rows[0];
  if (!entry || entry.status !== "pending_approval") {
    return { handled: false };
  }

  if (entry.approvalChannel && entry.approvalChannel !== channelId) {
    return { handled: false };
  }

  const policy = await getApprovalPolicy(entry.toolName);
  const authorizedApprovers = getApproverIds(policy);

  if (authorizedApprovers.length > 0 && !authorizedApprovers.includes(userId)) {
    logger.warn("Unauthorized approval attempt", {
      userId,
      actionLogId: entry.id,
      toolName: entry.toolName,
    });
    return { handled: false };
  }

  if (isApprove) {
    await updateActionLog(entry.id, {
      status: "approved",
      approvedBy: userId,
      approvedAt: new Date(),
    });

    logger.info("Action approved", {
      actionLogId: entry.id,
      toolName: entry.toolName,
      approvedBy: userId,
    });

    return { handled: true, action: "approved" };
  }

  await updateActionLog(entry.id, {
    status: "rejected",
    approvedBy: userId,
    approvedAt: new Date(),
  });

  logger.info("Action rejected", {
    actionLogId: entry.id,
    toolName: entry.toolName,
    rejectedBy: userId,
  });

  return { handled: true, action: "rejected" };
}

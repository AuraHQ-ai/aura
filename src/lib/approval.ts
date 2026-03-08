import { WebClient } from "@slack/web-api";
import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  actionLog,
  approvalPolicies,
  jobs,
  type ApprovalPolicy,
  type ScheduleContext,
} from "../db/schema.js";
import { logger } from "./logger.js";

export type { ApprovalPolicy };

// ── Types ───────────────────────────────────────────────────────────────────

export interface ExecutionContext {
  userId?: string;
  channelId?: string;
  threadTs?: string;
  jobId?: string;
  triggerType: "user_message" | "scheduled_job" | "autonomous";
}

// ── URL Pattern Matching ────────────────────────────────────────────────────

/**
 * Simple glob matcher for URL patterns.
 * Supports `*` (match one path segment) and `**` (match any number of segments).
 * Strips protocol from both pattern and URL before matching.
 */
function matchUrlPattern(pattern: string, url: string): boolean {
  const stripProtocol = (s: string) => s.replace(/^https?:\/\//, "");
  const normalizedUrl = stripProtocol(url).replace(/\/$/, "");
  const normalizedPattern = stripProtocol(pattern).replace(/\/$/, "");

  const regexStr = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]+")
    .replace(/§§/g, ".*");

  return new RegExp(`^${regexStr}$`).test(normalizedUrl);
}

/**
 * Compute a specificity score for a pattern so more specific matches win.
 * Fewer wildcards and more literal segments = higher specificity.
 */
function patternSpecificity(pattern: string): number {
  const stripped = pattern.replace(/^https?:\/\//, "");
  const segments = stripped.split("/");
  let score = 0;
  for (const seg of segments) {
    if (seg === "**") score += 0;
    else if (seg.includes("*")) score += 1;
    else score += 2;
  }
  return score;
}

// ── Default Risk Tier by HTTP Method ────────────────────────────────────────

const METHOD_DEFAULT_TIER: Record<string, "read" | "write" | "destructive"> = {
  GET: "read",
  HEAD: "read",
  OPTIONS: "read",
  POST: "write",
  PUT: "write",
  PATCH: "write",
  DELETE: "destructive",
};

// ── Policy Lookup ───────────────────────────────────────────────────────────

export async function lookupPolicy(args: {
  toolName: string;
  url?: string;
  method?: string;
  credentialName?: string;
}): Promise<ApprovalPolicy | null> {
  const rows = await db.select().from(approvalPolicies);

  const candidates: Array<{ policy: ApprovalPolicy; specificity: number }> = [];

  for (const policy of rows) {
    if (args.toolName === "http_request") {
      if (policy.urlPattern && args.url) {
        if (!matchUrlPattern(policy.urlPattern, args.url)) continue;

        if (
          policy.httpMethods &&
          policy.httpMethods.length > 0 &&
          args.method &&
          !policy.httpMethods.includes(args.method.toUpperCase())
        ) {
          continue;
        }

        if (
          policy.credentialName &&
          args.credentialName &&
          policy.credentialName !== args.credentialName
        ) {
          continue;
        }

        candidates.push({
          policy,
          specificity: patternSpecificity(policy.urlPattern),
        });
      } else if (policy.toolPattern === "http_request") {
        candidates.push({ policy, specificity: 0 });
      }
    } else {
      if (policy.toolPattern === args.toolName) {
        candidates.push({ policy, specificity: 100 });
      }
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.specificity - a.specificity);
  return candidates[0].policy;
}

/**
 * Determine the effective risk tier for a tool invocation.
 * If a policy matches, use its tier. Otherwise fall back to method-based defaults
 * for http_request, or "write" for named tools.
 */
export function effectiveRiskTier(
  policy: ApprovalPolicy | null,
  method?: string,
): "read" | "write" | "destructive" {
  if (policy) return policy.riskTier as "read" | "write" | "destructive";
  if (method) return METHOD_DEFAULT_TIER[method.toUpperCase()] ?? "write";
  return "write";
}

// ── Request Approval (post Slack message + write action_log row) ────────────

export async function requestApproval(args: {
  actionLogId: string;
  toolName: string;
  params: unknown;
  riskTier: string;
  policy: ApprovalPolicy | null;
  context: ExecutionContext;
  slackClient?: InstanceType<typeof import("@slack/web-api").WebClient> | null;
}): Promise<void> {
  const { actionLogId, toolName, params, riskTier, policy, context, slackClient: injectedSlackClient } = args;
  const slackClient = injectedSlackClient ?? new WebClient(process.env.SLACK_BOT_TOKEN);

  const row = await db
    .select()
    .from(actionLog)
    .where(eq(actionLog.id, actionLogId))
    .limit(1);

  const logEntry = row[0];
  if (!logEntry) {
    throw new Error(`action_log row ${actionLogId} not found`);
  }

  const channel = policy?.approvalChannel ?? undefined;
  const approvers = policy?.approverIds ?? [];
  const approverMentions =
    approvers.length > 0
      ? approvers.map((id) => `<@${id}>`).join(", ")
      : "admins";

  const paramsSummary = JSON.stringify(logEntry.params, null, 2);
  const truncatedParams =
    paramsSummary.length > 2800
      ? paramsSummary.slice(0, 2800) + "\n... (truncated)"
      : paramsSummary;

  const blocks = [
    {
      type: "header" as const,
      text: {
        type: "plain_text" as const,
        text: `🔒 Approval Required: ${toolName}`,
        emoji: true,
      },
    },
    {
      type: "section" as const,
      text: {
        type: "mrkdwn" as const,
        text: `*Risk tier:* \`${riskTier}\`\n*Requested by:* <@${logEntry.triggeredBy}>\n*Trigger:* ${logEntry.triggerType}${logEntry.jobId ? `\n*Job:* ${logEntry.jobId}` : ""}`,
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
          text: { type: "plain_text" as const, text: "✅ Approve", emoji: true },
          style: "primary" as const,
          action_id: `governance_approve_${actionLogId}`,
          value: actionLogId,
        },
        {
          type: "button" as const,
          text: { type: "plain_text" as const, text: "❌ Reject", emoji: true },
          style: "danger" as const,
          action_id: `governance_reject_${actionLogId}`,
          value: actionLogId,
        },
      ],
    },
    {
      type: "context" as const,
      elements: [
        {
          type: "mrkdwn" as const,
          text: `${approverMentions} • \`action_log_id: ${actionLogId}\``,
        },
      ],
    },
  ];

  let targetChannel: string;

  if (channel) {
    targetChannel = channel;
  } else if (context.channelId) {
    targetChannel = context.channelId;
  } else {
    const dm = await slackClient.conversations.open({
      users: logEntry.triggeredBy,
    });
    targetChannel = dm.channel?.id ?? logEntry.triggeredBy;
  }

  await slackClient.chat.postMessage({
    channel: targetChannel,
    ...(context.threadTs ? { thread_ts: context.threadTs } : {}),
    text: `Approval required for ${toolName} (${riskTier})`,
    blocks,
    metadata: {
      event_type: "approval_request",
      event_payload: {
        action_log_id: actionLogId,
      },
    },
  });

  if (context.jobId) {
    await db
      .update(jobs)
      .set({
        approvalStatus: "awaiting_approval",
        pendingActionLogId: actionLogId,
      })
      .where(eq(jobs.id, context.jobId));
  }

  logger.info("Approval requested", {
    actionLogId,
    toolName,
    riskTier,
    channel: targetChannel,
  });
}

// ── Handle Approval Reaction ────────────────────────────────────────────────

export async function handleApprovalReaction(args: {
  actionLogId: string;
  reaction: string;
  reactorUserId: string;
  slackClient: InstanceType<typeof import("@slack/web-api").WebClient>;
}): Promise<void> {
  const { actionLogId, reaction, reactorUserId, slackClient } = args;

  const rows = await db
    .select()
    .from(actionLog)
    .where(eq(actionLog.id, actionLogId))
    .limit(1);

  const entry = rows[0];
  if (!entry) {
    logger.warn("handleApprovalReaction: action_log row not found", {
      actionLogId,
    });
    return;
  }

  if (entry.status !== "pending_approval") {
    logger.info("handleApprovalReaction: action already resolved", {
      actionLogId,
      currentStatus: entry.status,
    });
    return;
  }

  const policy = await lookupPolicy({
    toolName: entry.toolName,
    url:
      entry.toolName === "http_request"
        ? (entry.params as Record<string, unknown>)?.url as string
        : undefined,
    method:
      entry.toolName === "http_request"
        ? (entry.params as Record<string, unknown>)?.method as string
        : undefined,
  });

  const allowedApprovers = policy?.approverIds ?? [];
  const adminIds = (process.env.AURA_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const isAuthorized =
    allowedApprovers.length === 0
      ? adminIds.includes(reactorUserId)
      : allowedApprovers.includes(reactorUserId);

  if (!isAuthorized) {
    logger.warn("handleApprovalReaction: unauthorized reactor", {
      actionLogId,
      reactorUserId,
    });
    return;
  }

  const isApproved = reaction === "white_check_mark";
  const newStatus = isApproved ? "approved" : "rejected";

  await db
    .update(actionLog)
    .set({
      status: newStatus,
      approvedBy: reactorUserId,
      approvedAt: new Date(),
    })
    .where(eq(actionLog.id, actionLogId));

  if (entry.jobId) {
    if (isApproved) {
      await db
        .update(jobs)
        .set({
          approvalStatus: null,
          pendingActionLogId: null,
          status: "pending",
        })
        .where(eq(jobs.id, entry.jobId));
    } else {
      await db
        .update(jobs)
        .set({
          approvalStatus: null,
          pendingActionLogId: null,
          status: "cancelled",
          result: `Rejected by <@${reactorUserId}>`,
        })
        .where(eq(jobs.id, entry.jobId));
    }
  }

  logger.info("Approval reaction handled", {
    actionLogId,
    reaction,
    newStatus,
    reactorUserId,
  });
}

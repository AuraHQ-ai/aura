import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { actionLog, approvalPolicies, jobs } from "../db/schema.js";
import type { ApprovalPolicy } from "../db/schema.js";
import { isAdmin } from "./permissions.js";
import { logger } from "./logger.js";

// ── Policy Lookup ────────────────────────────────────────────────────────────

export type RiskTier = "read" | "write" | "destructive";

interface LookupParams {
  toolName: string;
  url?: string;
  method?: string;
  credentialName?: string;
}

interface PolicyResult {
  riskTier: RiskTier;
  policy: ApprovalPolicy | null;
}

/**
 * Look up the applicable approval policy for a tool call.
 *
 * Matching order:
 * 1. For http_request: most-specific url_pattern + http_methods match
 * 2. Exact tool_pattern match
 * 3. Fallback defaults: GET=read, POST/PATCH/PUT=write, DELETE=destructive;
 *    for non-http tools, default to "write"
 */
export async function lookupPolicy(params: LookupParams): Promise<PolicyResult> {
  const { toolName, url, method, credentialName } = params;

  const allPolicies = await db
    .select()
    .from(approvalPolicies)
    .orderBy(sql`length(coalesce(url_pattern, '')) DESC`);

  // For http_request, try url_pattern + method matching first
  if (toolName === "http_request" && url) {
    for (const policy of allPolicies) {
      if (!policy.urlPattern) continue;

      if (!urlMatchesPattern(url, policy.urlPattern)) continue;

      if (policy.httpMethods && policy.httpMethods.length > 0) {
        if (method && !policy.httpMethods.includes(method.toUpperCase())) continue;
      }

      if (policy.credentialName && policy.credentialName !== credentialName) continue;

      return { riskTier: policy.riskTier as RiskTier, policy };
    }
  }

  // Try exact tool_pattern match
  for (const policy of allPolicies) {
    if (!policy.toolPattern) continue;
    if (policy.toolPattern !== toolName) continue;
    if (policy.credentialName && policy.credentialName !== credentialName) continue;

    return { riskTier: policy.riskTier as RiskTier, policy };
  }

  // Fallback defaults
  if (toolName === "http_request" && method) {
    const upperMethod = method.toUpperCase();
    if (upperMethod === "GET" || upperMethod === "HEAD" || upperMethod === "OPTIONS") {
      return { riskTier: "read", policy: null };
    }
    if (upperMethod === "DELETE") {
      return { riskTier: "destructive", policy: null };
    }
    return { riskTier: "write", policy: null };
  }

  return { riskTier: "write", policy: null };
}

function urlMatchesPattern(url: string, pattern: string): boolean {
  try {
    const parsed = new URL(url);
    const urlPath = parsed.hostname + parsed.pathname;
    const regexStr = "^" + pattern.replace(/\*/g, "[^/]*") + "(/.*)?$";
    return new RegExp(regexStr).test(urlPath);
  } catch {
    return false;
  }
}

// ── Approval Message ─────────────────────────────────────────────────────────

export interface RequestApprovalParams {
  actionLogId: string;
  toolName: string;
  params: unknown;
  riskTier: string;
  policy: ApprovalPolicy | null;
  triggeredBy: string;
  jobId?: string;
}

/**
 * Post an approval request message to the appropriate Slack channel.
 * Embeds the action_log ID in message metadata for the reaction handler.
 */
export async function requestApproval(params: RequestApprovalParams): Promise<void> {
  const { WebClient } = await import("@slack/web-api");
  const botToken = process.env.SLACK_BOT_TOKEN || "";
  const slackClient = new WebClient(botToken);

  const { actionLogId, toolName, params: toolParams, riskTier, policy, triggeredBy, jobId } = params;

  const paramsDisplay = typeof toolParams === "object"
    ? JSON.stringify(toolParams, null, 2).slice(0, 2000)
    : String(toolParams).slice(0, 2000);

  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `:warning: Approval Required — ${toolName}`, emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Risk Tier:*\n\`${riskTier}\`` },
        { type: "mrkdwn", text: `*Triggered By:*\n<@${triggeredBy}>` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Parameters:*\n\`\`\`${paramsDisplay}\`\`\`` },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `React with :white_check_mark: to approve or :x: to reject` },
      ],
    },
  ];

  if (jobId) {
    blocks.splice(2, 0, {
      type: "section",
      fields: [{ type: "mrkdwn", text: `*Job ID:*\n\`${jobId}\`` }],
    });
  }

  const metadata = {
    event_type: "aura_approval_request",
    event_payload: { action_log_id: actionLogId },
  };

  const channel = policy?.approvalChannel || triggeredBy;

  try {
    await slackClient.chat.postMessage({
      channel,
      text: `Approval required for ${toolName} (${riskTier}). React ✅ to approve, ❌ to reject.`,
      blocks,
      metadata,
    });
    logger.info("Approval request posted", { actionLogId, toolName, channel });
  } catch (err: any) {
    logger.error("Failed to post approval request", { actionLogId, error: err.message });
    // If posting to a channel fails, try DM to triggeredBy
    if (channel !== triggeredBy) {
      try {
        await slackClient.chat.postMessage({
          channel: triggeredBy,
          text: `Approval required for ${toolName} (${riskTier}). React ✅ to approve, ❌ to reject.`,
          blocks,
          metadata,
        });
      } catch (dmErr: any) {
        logger.error("Failed to post approval DM fallback", { actionLogId, error: dmErr.message });
      }
    }
  }
}

// ── Approval Reaction Handler ────────────────────────────────────────────────

export interface HandleApprovalReactionParams {
  actionLogId: string;
  reaction: string;
  reactorUserId: string;
}

/**
 * Handle an approval or rejection reaction on an action_log entry.
 * Called from the reaction_added event handler in app.ts.
 */
export async function handleApprovalReaction(params: HandleApprovalReactionParams): Promise<void> {
  const { actionLogId, reaction, reactorUserId } = params;

  const logRows = await db
    .select()
    .from(actionLog)
    .where(eq(actionLog.id, actionLogId))
    .limit(1);

  const logRow = logRows[0];
  if (!logRow || logRow.status !== "pending_approval") {
    logger.info("Approval reaction: action not pending", { actionLogId, status: logRow?.status });
    return;
  }

  // Look up the policy that gated this action to verify approver authorization
  const { policy } = await lookupPolicy({
    toolName: logRow.toolName,
    credentialName: logRow.credentialName ?? undefined,
  });

  const approverIds = policy?.approverIds ?? null;
  const isAuthorized = approverIds
    ? approverIds.includes(reactorUserId)
    : isAdmin(reactorUserId);

  if (!isAuthorized) {
    logger.info("Approval reaction: reactor not authorized", {
      actionLogId,
      reactorUserId,
      approverIds,
    });
    return;
  }

  const { WebClient } = await import("@slack/web-api");
  const botToken = process.env.SLACK_BOT_TOKEN || "";
  const slackClient = new WebClient(botToken);

  if (reaction === "white_check_mark") {
    await db
      .update(actionLog)
      .set({
        status: "approved",
        approvedBy: reactorUserId,
        approvedAt: new Date(),
      })
      .where(eq(actionLog.id, actionLogId));

    // Re-enqueue the associated job
    await db
      .update(jobs)
      .set({
        status: "pending",
        approvalStatus: "approved",
        executeAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(jobs.pendingActionLogId, actionLogId));

    logger.info("Action approved", { actionLogId, approvedBy: reactorUserId });

    // Notify job creator
    if (logRow.triggeredBy && logRow.triggeredBy !== "unknown") {
      try {
        await slackClient.chat.postMessage({
          channel: logRow.triggeredBy,
          text: `Your action \`${logRow.toolName}\` has been approved by <@${reactorUserId}>.`,
        });
      } catch { /* non-critical */ }
    }
  } else if (reaction === "x") {
    await db
      .update(actionLog)
      .set({
        status: "rejected",
        approvedBy: reactorUserId,
        approvedAt: new Date(),
      })
      .where(eq(actionLog.id, actionLogId));

    // Cancel the associated job
    const cancelledJobs = await db
      .update(jobs)
      .set({
        status: "cancelled",
        approvalStatus: "rejected",
        updatedAt: new Date(),
      })
      .where(eq(jobs.pendingActionLogId, actionLogId))
      .returning({ id: jobs.id, requestedBy: jobs.requestedBy });

    logger.info("Action rejected", { actionLogId, rejectedBy: reactorUserId });

    // Notify job creator
    const job = cancelledJobs[0];
    if (job?.requestedBy && job.requestedBy !== "aura") {
      try {
        await slackClient.chat.postMessage({
          channel: job.requestedBy,
          text: `Your action \`${logRow.toolName}\` was rejected by <@${reactorUserId}>. The associated job has been cancelled.`,
        });
      } catch { /* non-critical */ }
    }
  }
}

/**
 * Action governance middleware: wraps tool execution with risk-tier-based
 * logging and approval gates.
 *
 * - `read` tools: execute normally (no logging overhead)
 * - `write` tools: execute + log to action_log
 * - `destructive` tools: block execution, write pending_approval, post Slack
 *   approval message, return pending status
 *
 * The module-level `originalExecutors` map stores unwrapped execute functions
 * so the approval reaction handler can invoke them without re-triggering
 * governance.
 */

import type { WebClient } from "@slack/web-api";
import type { ScheduleContext } from "../db/schema.js";
import { getToolRisk } from "./tool.js";
import {
  writeActionLog,
  updateActionLog,
  getActionLogEntry,
  getApprovalPolicy,
  resolveRiskTier,
  getApprovalChannel,
  buildApprovalMessage,
  scrubSecrets,
  type RiskTier,
} from "./approval.js";
import { logger } from "./logger.js";

// ── Original executor registry ─────────────────────────────────────────────

const originalExecutors = new Map<string, (input: any) => PromiseLike<any>>();

/** Module-level bypass flag. When true, governance wrapping is skipped. */
let _governanceBypass = false;

// ── Tool wrapping ──────────────────────────────────────────────────────────

/**
 * Wrap all risk-annotated tools in the tools map with governance logic.
 * Must be called after tools are created (e.g. at the end of createSlackTools).
 *
 * @param tools - The tools map (mutated in place)
 * @param slackClient - Slack WebClient for posting approval messages
 * @param context - Current conversation context (userId, channelId, etc.)
 */
export function wrapToolsWithGovernance(
  tools: Record<string, any>,
  slackClient: WebClient,
  context?: ScheduleContext,
): void {
  for (const [toolName, toolDef] of Object.entries(tools)) {
    const risk = getToolRisk(toolDef);
    if (!risk) continue;

    const originalExecute = toolDef.execute;
    if (typeof originalExecute !== "function") continue;

    originalExecutors.set(toolName, originalExecute);

    const triggeredBy = context?.userId ?? "unknown";
    const triggerType = context?.channelId ? "interactive" : "job";

    const wrappedExecute = async (input: any) => {
      if (_governanceBypass) {
        return originalExecute(input);
      }

      const policy = await getApprovalPolicy(toolName);
      const effectiveRisk = resolveRiskTier(risk, policy);

      if (effectiveRisk === "read") {
        return originalExecute(input);
      }

      if (effectiveRisk === "write") {
        let result: any;
        let status: "executed" | "failed" = "executed";
        try {
          result = await originalExecute(input);
        } catch (err: any) {
          status = "failed";
          result = { error: err.message };
        }

        writeActionLog({
          toolName,
          params: input as Record<string, unknown>,
          result: typeof result === "object" ? result : { value: result },
          status,
          riskTier: effectiveRisk,
          triggerType,
          triggeredBy,
        }).catch((err) => {
          logger.error("Failed to write action_log for write tool", {
            toolName,
            error: err,
          });
        });

        if (status === "failed") throw new Error(result.error);
        return result;
      }

      // effectiveRisk === "destructive" — require approval
      const approvalChannel = getApprovalChannel(policy);
      if (!approvalChannel) {
        logger.error(
          "No approval channel configured for destructive tool",
          { toolName },
        );
        return {
          ok: false,
          error:
            "This action requires approval but no approval channel is configured. " +
            "An admin must set AURA_APPROVAL_CHANNEL or create an approval_policy for this tool.",
        };
      }

      const entry = await writeActionLog({
        toolName,
        params: input as Record<string, unknown>,
        status: "pending_approval",
        riskTier: "destructive",
        triggerType,
        triggeredBy,
        approvalChannel,
      });

      const { text, blocks } = buildApprovalMessage(
        entry.id,
        toolName,
        input as Record<string, unknown>,
        triggeredBy,
      );

      try {
        const msgResult = await slackClient.chat.postMessage({
          channel: approvalChannel,
          text,
          blocks,
        });

        if (msgResult.ts) {
          await updateActionLog(entry.id, {
            approvalMessageTs: msgResult.ts,
          });
        }
      } catch (err) {
        logger.error("Failed to post approval message", {
          toolName,
          actionLogId: entry.id,
          error: err,
        });
      }

      return {
        ok: false,
        pending_approval: true,
        action_log_id: entry.id,
        message: `This action requires admin approval. A request has been posted in the approval channel. The action will be executed once approved.`,
      };
    };

    toolDef.execute = wrappedExecute;
  }
}

// ── Approved action execution ──────────────────────────────────────────────

/**
 * Execute a previously approved action. Called from the reaction handler.
 *
 * @returns The tool execution result, or an error object.
 */
export async function executeApprovedAction(
  actionLogId: string,
  slackClient: WebClient,
): Promise<{ ok: boolean; result?: any; error?: string }> {
  const entry = await getActionLogEntry(actionLogId);
  if (!entry) {
    return { ok: false, error: "Action log entry not found" };
  }
  if (entry.status !== "approved") {
    return { ok: false, error: `Action is not approved (status: ${entry.status})` };
  }

  const executor = originalExecutors.get(entry.toolName);

  if (executor) {
    return runExecutor(executor, entry.id, entry.toolName, entry.params, slackClient, entry.approvalChannel);
  }

  // Fallback: re-create tools with bypass to get the executor
  return runWithFreshTools(entry, slackClient);
}

async function runExecutor(
  executor: (input: any) => PromiseLike<any>,
  actionLogId: string,
  toolName: string,
  params: Record<string, unknown> | null,
  slackClient: WebClient,
  approvalChannel: string | null,
): Promise<{ ok: boolean; result?: any; error?: string }> {
  try {
    _governanceBypass = true;
    const result = await executor(params ?? {});
    _governanceBypass = false;

    await updateActionLog(actionLogId, {
      status: "executed" as any,
      result: typeof result === "object" ? result : { value: result },
    });

    if (approvalChannel) {
      const resultSummary =
        result?.ok === true
          ? "✅ Action executed successfully."
          : result?.ok === false
            ? `⚠️ Action completed with error: ${result.error || "unknown"}`
            : "✅ Action executed.";

      await slackClient.chat.postMessage({
        channel: approvalChannel,
        text: `${resultSummary}\n\`${toolName}\` (action \`${actionLogId}\`)`,
      }).catch((err) => {
        logger.error("Failed to post execution result", { actionLogId, error: err });
      });
    }

    return { ok: true, result };
  } catch (err: any) {
    _governanceBypass = false;

    await updateActionLog(actionLogId, {
      status: "failed" as any,
      result: { error: err.message },
    });

    return { ok: false, error: err.message };
  }
}

async function runWithFreshTools(
  entry: NonNullable<Awaited<ReturnType<typeof getActionLogEntry>>>,
  slackClient: WebClient,
): Promise<{ ok: boolean; result?: any; error?: string }> {
  try {
    const { createSlackTools } = await import("../tools/slack.js");
    const context: ScheduleContext = {
      userId: entry.triggeredBy,
    };

    _governanceBypass = true;
    const tools = createSlackTools(slackClient, context);
    const toolDef = (tools as Record<string, any>)[entry.toolName];
    _governanceBypass = false;

    if (!toolDef?.execute) {
      return {
        ok: false,
        error: `Tool "${entry.toolName}" not found in registry`,
      };
    }

    return runExecutor(
      toolDef.execute,
      entry.id,
      entry.toolName,
      entry.params,
      slackClient,
      entry.approvalChannel,
    );
  } catch (err: any) {
    _governanceBypass = false;
    return { ok: false, error: `Failed to re-create tools: ${err.message}` };
  }
}

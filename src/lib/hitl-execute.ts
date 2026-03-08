import type { WebClient } from "@slack/web-api";
import type { pendingApprovals } from "../db/schema.js";
import { createSlackTools } from "../tools/slack.js";
import { safePostMessage } from "./slack-messaging.js";
import { logger } from "./logger.js";

/**
 * Execute a tool that was approved via the HITL flow.
 * Looks up the tool by name in the tools registry, calls it with the
 * stored args, and posts the result back to the originating Slack thread.
 */
export async function executeApprovedTool(
  approval: typeof pendingApprovals.$inferSelect,
  slackClient: WebClient,
): Promise<void> {
  const { toolName, args, channelId, threadTs } = approval;

  const tools = createSlackTools(slackClient, {
    userId: approval.userId,
    channelId,
    threadTs: threadTs ?? undefined,
  });

  const toolDef = (tools as Record<string, any>)[toolName];
  if (!toolDef || typeof toolDef.execute !== "function") {
    logger.warn("HITL execute: tool not found or not executable", { toolName });
    await safePostMessage(slackClient, {
      channel: channelId,
      thread_ts: threadTs ?? undefined,
      text: `Could not execute \`${toolName}\` — tool not found.`,
    });
    return;
  }

  try {
    const result = await toolDef.execute(args);

    const resultStr = typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2);

    const truncated = resultStr.length > 3000
      ? resultStr.slice(0, 3000) + "\n... (truncated)"
      : resultStr;

    await safePostMessage(slackClient, {
      channel: channelId,
      thread_ts: threadTs ?? undefined,
      text: `\`${toolName}\` executed after approval:\n\`\`\`${truncated}\`\`\``,
    });

    logger.info("HITL execute: tool executed successfully", {
      approvalId: approval.id,
      toolName,
    });
  } catch (err: any) {
    logger.error("HITL execute: tool execution failed", {
      approvalId: approval.id,
      toolName,
      error: err?.message,
    });

    await safePostMessage(slackClient, {
      channel: channelId,
      thread_ts: threadTs ?? undefined,
      text: `\`${toolName}\` failed after approval: ${err?.message || "Unknown error"}`,
    });
  }
}

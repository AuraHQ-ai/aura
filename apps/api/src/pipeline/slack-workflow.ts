import type { WebClient } from "@slack/web-api";
import type { MessageContext } from "./context.js";
import type { FileContentPart } from "../lib/files.js";
import { getSettingJSON } from "../lib/settings.js";
import { getMainModelId } from "../lib/ai.js";
import { logger } from "../lib/logger.js";
import {
  slackRespondWorkflow,
  type SlackRespondWorkflowInput,
} from "../../workflows/slack-respond.js";

/**
 * Feature flag for the durable (WDK) Slack respond path. Off by default —
 * the legacy in-process streaming path in respond.ts remains the default
 * until the workflow path has been validated in production (issue #1111).
 *
 * Enable via env `AURA_WDK_SLACK_RESPOND=1` (highest priority) or the
 * `wdk_slack_respond` setting (true/false).
 */
export async function isWdkSlackRespondEnabled(): Promise<boolean> {
  const env = process.env.AURA_WDK_SLACK_RESPOND;
  if (env === "1" || env === "true") return true;
  if (env === "0" || env === "false") return false;
  try {
    return (await getSettingJSON<boolean>("wdk_slack_respond", false)) ?? false;
  } catch {
    return false;
  }
}

export interface StartSlackRespondWorkflowParams {
  stablePrefix: string;
  environmentContext: string;
  conversationContext: string;
  dynamicContext?: string;
  userMessage: string;
  files?: FileContentPart[];
  channelId: string;
  threadTs: string;
  teamId?: string;
  recipientUserId?: string;
  userId: string;
  workspaceId?: string;
  timezone?: string;
  invocationId: string;
  background: SlackRespondWorkflowInput["background"];
}

/**
 * Start the durable Slack respond workflow. Returns the run id, or null when
 * the workflow could not be started (e.g. running outside a WDK-compiled
 * build) — the caller should fall back to the legacy in-process path.
 */
export async function startSlackRespondWorkflow(
  params: StartSlackRespondWorkflowParams,
): Promise<string | null> {
  try {
    const { start } = await import("workflow/api");
    const modelId = await getMainModelId();
    const input: SlackRespondWorkflowInput = {
      ...params,
      modelId,
    };
    const run = await start(slackRespondWorkflow, [input]);
    logger.info("Slack respond workflow started", {
      runId: run.runId,
      channelId: params.channelId,
      threadTs: params.threadTs,
      invocationId: params.invocationId,
    });
    return run.runId;
  } catch (error: any) {
    logger.error("Failed to start Slack respond workflow — falling back to legacy path", {
      error: error?.message || String(error),
      channelId: params.channelId,
    });
    return null;
  }
}

/** Narrow check used by the pipeline to decide if delegation makes sense. */
export function isWorkflowEligible(options: {
  channelType?: string;
  isHeadless?: boolean;
  client?: WebClient;
  context?: MessageContext;
}): boolean {
  if (options.isHeadless) return false;
  // Slack List item comment threads don't support chat.startStream; the
  // legacy path has dedicated fallbacks for them.
  if (options.channelType === "slack_list_item") return false;
  return true;
}

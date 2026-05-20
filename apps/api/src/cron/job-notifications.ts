import { WebClient } from "@slack/web-api";
import { logger } from "../lib/logger.js";
import { safePostMessage } from "../lib/slack-messaging.js";
import { resolveSlackDestination } from "../tools/slack.js";

const botToken = process.env.SLACK_BOT_TOKEN || "";
const slackClient = new WebClient(botToken);

export function truncateJobFailureText(value: string | null | undefined, maxChars = 400): string {
  const text = value?.trim() || "unknown";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

export function resolveJobFailureDmTarget(
  requestedBy: string | null | undefined,
): string | null {
  const requester = requestedBy?.trim();
  if (requester && requester !== "aura") return requester;
  return null;
}

export async function sendJobFailureDm({
  jobId,
  requestedBy,
  text,
  logContext = {},
}: {
  jobId: string;
  requestedBy: string | null | undefined;
  text: string;
  logContext?: Record<string, unknown>;
}): Promise<boolean> {
  const target = resolveJobFailureDmTarget(requestedBy);

  if (!target) {
    const requester = requestedBy?.trim();
    logger.warn(
      requester === "aura"
        ? "job_failure_dm_skipped_system_owned"
        : "job_failure_dm_skipped_no_target",
      { jobId, requestedBy, ...logContext },
    );
    return false;
  }

  try {
    const dmChannelId = await resolveSlackDestination(slackClient, target);
    if (!dmChannelId) {
      logger.warn("Job failure DM skipped: target did not resolve", {
        jobId,
        target,
        ...logContext,
      });
      return false;
    }

    await safePostMessage(slackClient, {
      channel: dmChannelId,
      text,
    });

    return true;
  } catch (error: any) {
    logger.error("Job failure DM failed", {
      jobId,
      target,
      error: error?.message,
      ...logContext,
    });
    return false;
  }
}

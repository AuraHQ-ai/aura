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

function firstAdminUserId(): string | null {
  return (
    (process.env.AURA_ADMIN_USER_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .find(Boolean) ?? null
  );
}

export function resolveJobFailureDmTarget(
  requestedBy: string | null | undefined,
  { fallbackToAdmin = true }: { fallbackToAdmin?: boolean } = {},
): string | null {
  const requester = requestedBy?.trim();
  if (requester && requester !== "aura") return requester;
  if (!fallbackToAdmin) return null;

  return process.env.FOUNDER_USER_ID?.trim() || firstAdminUserId();
}

export async function sendJobFailureDm({
  jobId,
  requestedBy,
  text,
  fallbackToAdmin = true,
  logContext = {},
}: {
  jobId: string;
  requestedBy: string | null | undefined;
  text: string;
  fallbackToAdmin?: boolean;
  logContext?: Record<string, unknown>;
}): Promise<boolean> {
  const target = resolveJobFailureDmTarget(requestedBy, { fallbackToAdmin });

  if (!target) {
    logger.warn("Job failure DM skipped: no target", { jobId, ...logContext });
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

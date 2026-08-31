import { WebClient } from "@slack/web-api";
import { logError } from "../lib/error-logger.js";
import { logger } from "../lib/logger.js";
import { getSetting } from "../lib/settings.js";
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

export type OpsNoticeTargetKind = "ops_channel" | "founder_dm" | "requester_dm";

export type OpsNoticeTarget = {
  kind: OpsNoticeTargetKind;
  destination: string;
};

/** Settings key for the ops channel (channel ID or name). Takes priority over the AURA_OPS_CHANNEL env var. */
export const OPS_CHANNEL_SETTING_KEY = "aura_ops_channel";
/** Settings key for the founder's Slack user ID. Takes priority over the FOUNDER_USER_ID env var. */
export const FOUNDER_USER_ID_SETTING_KEY = "founder_user_id";

/**
 * Resolve the founder's Slack user ID: DB setting first (editable from the
 * dashboard), then the FOUNDER_USER_ID env var. Returns null when neither
 * is configured.
 */
export async function resolveFounderUserId(): Promise<string | null> {
  return (
    (await getSetting(FOUNDER_USER_ID_SETTING_KEY))?.trim() ||
    process.env.FOUNDER_USER_ID?.trim() ||
    null
  );
}

/**
 * Resolve where internal job lifecycle/ops notices (retries, escalations,
 * disable notices, retry-exhausted alerts) should go. These are internal
 * plumbing, NOT user deliverables, so they must not land in the requester's
 * DM when an ops destination is configured.
 *
 * Fallback ladder (DB settings first so ops routing is configurable from the
 * dashboard without a redeploy):
 * 1. settings.aura_ops_channel (channel ID or name)
 * 2. AURA_OPS_CHANNEL env (channel ID or name)
 * 3. settings.founder_user_id (DM)
 * 4. FOUNDER_USER_ID env (DM)
 * 5. Last resort only: DM requestedBy (keeps the `requestedBy === "aura"` skip)
 */
export async function resolveOpsNotificationTarget(
  requestedBy: string | null | undefined,
): Promise<OpsNoticeTarget | null> {
  const opsChannel =
    (await getSetting(OPS_CHANNEL_SETTING_KEY))?.trim() ||
    process.env.AURA_OPS_CHANNEL?.trim();
  if (opsChannel) return { kind: "ops_channel", destination: opsChannel };

  const founderUserId = await resolveFounderUserId();
  if (founderUserId) return { kind: "founder_dm", destination: founderUserId };

  const requester = resolveJobFailureDmTarget(requestedBy);
  if (requester) return { kind: "requester_dm", destination: requester };

  return null;
}

function formatRequesterMention(requestedBy: string | null | undefined): string {
  const requester = requestedBy?.trim();
  if (!requester) return "unknown";
  if (/^[UW][A-Z0-9_]+$/.test(requester)) return `<@${requester}>`;
  return requester;
}

export type SendJobOpsNoticeResult = {
  ok: boolean;
  target: OpsNoticeTargetKind | null;
};

/**
 * Send an internal job lifecycle/ops notice via the ops routing ladder
 * (ops channel → founder DM → requester DM as a last resort). When the
 * notice goes to an ops destination, it is prefixed with the job name and
 * requester so the reader knows whose job it is.
 */
export async function sendJobOpsNotice({
  jobId,
  jobName,
  requestedBy,
  text,
  logContext = {},
}: {
  jobId: string;
  jobName: string;
  requestedBy: string | null | undefined;
  text: string;
  logContext?: Record<string, unknown>;
}): Promise<SendJobOpsNoticeResult> {
  const target = await resolveOpsNotificationTarget(requestedBy);

  if (!target) {
    logger.warn("job_ops_notice_skipped_no_target", {
      jobId,
      jobName,
      requestedBy,
      ...logContext,
    });
    return { ok: false, target: null };
  }

  if (target.kind === "requester_dm") {
    logger.warn(
      "job_ops_notice_no_ops_destination_configured: set the aura_ops_channel / founder_user_id settings (or AURA_OPS_CHANNEL / FOUNDER_USER_ID env vars); falling back to requester DM",
      { jobId, jobName, requestedBy, ...logContext },
    );
    // Surface the misconfiguration in monitoring (error_events + #aura-errors),
    // not just in logs — an internal engineering notice is about to land in an
    // end user's DM.
    logError({
      errorName: "job_ops_notice_no_ops_destination",
      errorMessage: `Job ops notice for "${jobName}" fell back to the requester DM because no ops destination is configured. Set the aura_ops_channel or founder_user_id setting (or the AURA_OPS_CHANNEL / FOUNDER_USER_ID env vars).`,
      userId: target.destination,
      context: { jobId, jobName, requestedBy, ...logContext },
    });
  }

  const message =
    target.kind === "requester_dm"
      ? text
      : `:gear: Job ops notice — \`${jobName}\` (requested by ${formatRequesterMention(requestedBy)})\n${text}`;

  try {
    const channelId = await resolveSlackDestination(slackClient, target.destination);
    if (!channelId) {
      logger.warn("Job ops notice skipped: target did not resolve", {
        jobId,
        jobName,
        target: target.destination,
        targetKind: target.kind,
        ...logContext,
      });
      return { ok: false, target: target.kind };
    }

    await safePostMessage(slackClient, {
      channel: channelId,
      text: message,
    });

    return { ok: true, target: target.kind };
  } catch (error: any) {
    logger.error("Job ops notice failed", {
      jobId,
      jobName,
      target: target.destination,
      targetKind: target.kind,
      error: error?.message,
      ...logContext,
    });
    return { ok: false, target: target.kind };
  }
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

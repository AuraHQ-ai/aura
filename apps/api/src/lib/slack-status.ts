import type { WebClient } from "@slack/web-api";
import { logger } from "./logger.js";

/**
 * Channels where assistant.threads.setStatus has a persistent incompatibility.
 * Transient Slack/network failures are intentionally not cached.
 */
export const setStatusUnsupportedChannels = new Set<string>();

const PERSISTENT_SET_STATUS_ERRORS = new Set([
  "missing_scope",
  "not_authed",
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "not_allowed_token_type",
]);

function getSlackErrorCode(error: any): string | undefined {
  const code =
    error?.data?.error ??
    error?.error ??
    error?.code ??
    error?.statusCode ??
    error?.status;
  return code == null ? undefined : String(code);
}

function shouldDisableSetStatusForChannel(error: any): boolean {
  const code = getSlackErrorCode(error);
  if (code === "channel_not_found") return true;
  return !!code && PERSISTENT_SET_STATUS_ERRORS.has(code);
}

export async function trySetAssistantThreadStatus(params: {
  client: WebClient;
  channelId: string;
  threadTs?: string;
  status: string;
  loadingMessages?: string[];
}): Promise<void> {
  const { client, channelId, threadTs, status, loadingMessages } = params;
  if (!threadTs || setStatusUnsupportedChannels.has(channelId)) return;

  try {
    await client.assistant.threads.setStatus({
      channel_id: channelId,
      thread_ts: threadTs,
      status,
      ...(loadingMessages ? { loading_messages: loadingMessages } : {}),
    });
  } catch (error: any) {
    const slackError = getSlackErrorCode(error);
    if (shouldDisableSetStatusForChannel(error)) {
      setStatusUnsupportedChannels.add(channelId);
      logger.warn("assistant.threads.setStatus failed with persistent error; disabling for channel", {
        channelId,
        slackError,
        error: error?.message || String(error),
      });
      return;
    }

    logger.warn("assistant.threads.setStatus failed with transient error; will retry later", {
      channelId,
      slackError,
      error: error?.message || String(error),
    });
  }
}

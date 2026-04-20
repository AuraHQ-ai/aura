import type { WebClient } from "@slack/web-api";
import { logger } from "./logger.js";

/**
 * Channels where assistant.threads.setStatus previously failed.
 * We skip future attempts in these channels to avoid noisy retries.
 */
export const setStatusUnsupportedChannels = new Set<string>();

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
    setStatusUnsupportedChannels.add(channelId);
    logger.warn("assistant.threads.setStatus failed; disabling for channel", {
      channelId,
      error: error?.message || String(error),
    });
  }
}

import type { WebClient } from "@slack/web-api";
import { logger } from "./logger.js";

/**
 * Channels where agents.sessions.setStatus previously failed.
 * We skip future attempts in these channels to avoid noisy retries.
 */
export const setStatusUnsupportedChannels = new Set<string>();

export async function trySetAssistantThreadStatus(params: {
  client: WebClient;
  channelId: string;
  threadTs?: string;
  status: string;
}): Promise<void> {
  const { client, channelId, threadTs, status } = params;
  if (!threadTs || setStatusUnsupportedChannels.has(channelId)) return;

  try {
    // agents.sessions.* methods are untyped in @slack/web-api 8.0.0 — raw
    // apiCall is the sanctioned workaround until typed methods ship.
    // Payload fields per https://docs.slack.dev/reference/methods/agents.sessions.setstatus
    await client.apiCall("agents.sessions.setStatus", {
      channel_id: channelId,
      thread_ts: threadTs,
      status,
    });
  } catch (error: any) {
    setStatusUnsupportedChannels.add(channelId);
    logger.warn("agents.sessions.setStatus failed; disabling for channel", {
      channelId,
      error: error?.message || String(error),
    });
  }
}

/**
 * Set the title of an agent session via `agents.sessions.rename` (raw apiCall
 * — untyped in web-api 8.0.0). Payload fields per
 * https://docs.slack.dev/reference/methods/agents.sessions.rename
 * — the method takes `title` (not `name`), alongside `channel_id`/`thread_ts`.
 *
 * Errors propagate to the caller: every call site already wraps this in its
 * own try/catch with log-and-continue semantics, so a failing rename never
 * breaks message delivery.
 */
export async function setAssistantThreadTitle(params: {
  client: WebClient;
  channelId: string;
  threadTs: string;
  title: string;
}): Promise<void> {
  const { client, channelId, threadTs, title } = params;
  await client.apiCall("agents.sessions.rename", {
    channel_id: channelId,
    thread_ts: threadTs,
    title,
  });
}

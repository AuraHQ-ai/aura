import type { WebClient } from "@slack/web-api";
import { isSlackAgentViewEnabled } from "./slack-agent-view.js";
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

  const agentView = isSlackAgentViewEnabled();
  const method = agentView
    ? "agents.sessions.setStatus"
    : "assistant.threads.setStatus";

  try {
    if (agentView) {
      // agents.sessions.* methods are untyped in @slack/web-api 8.0.0 — raw
      // apiCall is the sanctioned workaround until typed methods ship.
      // Payload fields per https://docs.slack.dev/reference/methods/agents.sessions.setstatus
      // (`loading_messages` is not part of the documented arguments).
      await client.apiCall("agents.sessions.setStatus", {
        channel_id: channelId,
        thread_ts: threadTs,
        status,
      });
    } else {
      await client.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadTs,
        status,
        ...(loadingMessages ? { loading_messages: loadingMessages } : {}),
      });
    }
  } catch (error: any) {
    setStatusUnsupportedChannels.add(channelId);
    logger.warn(`${method} failed; disabling for channel`, {
      channelId,
      error: error?.message || String(error),
    });
  }
}

/**
 * Set the title of an assistant thread / agent session, branching on the
 * SLACK_AGENT_VIEW flag:
 * - off: `assistant.threads.setTitle` (legacy assistant_view path)
 * - on:  `agents.sessions.rename` via raw apiCall (untyped in web-api 8.0.0).
 *   Payload fields per https://docs.slack.dev/reference/methods/agents.sessions.rename
 *   — the method takes `title` (not `name`), alongside `channel_id`/`thread_ts`.
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
  if (isSlackAgentViewEnabled()) {
    await client.apiCall("agents.sessions.rename", {
      channel_id: channelId,
      thread_ts: threadTs,
      title,
    });
  } else {
    await client.assistant.threads.setTitle({
      channel_id: channelId,
      thread_ts: threadTs,
      title,
    });
  }
}

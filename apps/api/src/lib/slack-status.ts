import type { WebClient } from "@slack/web-api";
import { logger } from "./logger.js";

/**
 * The ONLY status values `agents.sessions.setStatus` accepts. Free-text
 * statuses (an assistant_view concept) are rejected with
 * `invalid_arguments` ("must be a valid enum value [json-pointer:/status]").
 * See https://docs.slack.dev/reference/methods/agents.sessions.setStatus
 */
export type SessionStatus = "suspended" | "processing" | "active" | "closed";

/**
 * Channels where agents.sessions.setStatus previously failed.
 * We skip future attempts in these channels to avoid noisy retries.
 */
export const setStatusUnsupportedChannels = new Set<string>();

/**
 * Set the agent-session status (the loading UX on Aura's name).
 *
 * IMPORTANT lifecycle contract (https://docs.slack.dev/ai/developing-agents):
 * the loading UX does NOT disappear automatically when the app posts a
 * message. Callers that set `"processing"` at turn start MUST set `"active"`
 * when the turn finishes (success or failure), or the session stays in
 * processing until Slack times it out after one hour.
 *
 * Soft-fail: on error the channel is added to the circuit-breaker set and a
 * warning is logged; the error never propagates.
 */
export async function trySetAgentSessionStatus(params: {
  client: WebClient;
  channelId: string;
  threadTs?: string;
  status: SessionStatus;
}): Promise<void> {
  const { client, channelId, threadTs, status } = params;
  if (!threadTs || setStatusUnsupportedChannels.has(channelId)) return;

  try {
    // agents.sessions.* methods are untyped in @slack/web-api 8.0.0 — raw
    // apiCall is the sanctioned workaround until typed methods ship.
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

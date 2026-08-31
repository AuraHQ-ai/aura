import type { WebClient } from "@slack/web-api";
import { logger } from "./logger.js";
import {
  agentsSessions,
  SESSION_UNSUPPORTED_ERROR_CODES,
  type AgentSessionStatus,
} from "./slack-agents-api.js";

/**
 * The ONLY status values `agents.sessions.setStatus` accepts. Free-text
 * statuses (an assistant_view concept) are rejected with
 * `invalid_arguments` ("must be a valid enum value [json-pointer:/status]").
 * See https://docs.slack.dev/reference/methods/agents.sessions.setStatus
 */
export type SessionStatus = AgentSessionStatus;

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
    await agentsSessions.setStatus(client, {
      channel_id: channelId,
      thread_ts: threadTs,
      status,
    });
  } catch (error: any) {
    const code: string | undefined = error?.data?.error;
    const detail = error?.data?.response_metadata?.messages;
    // Only a channel that can never host a session trips the breaker. Any
    // other failure (ratelimited, internal_error, a bad payload…) is per-call
    // — tripping on those is exactly what silently disabled the loading UX
    // for whole channels when the status enum regression shipped.
    if (code && SESSION_UNSUPPORTED_ERROR_CODES.has(code)) {
      setStatusUnsupportedChannels.add(channelId);
      logger.warn("agents.sessions.setStatus unsupported here; disabling for channel", {
        channelId,
        code,
      });
      return;
    }
    logger.warn("agents.sessions.setStatus failed (will retry next turn)", {
      channelId,
      status,
      code: code || error?.message || String(error),
      detail,
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
  await agentsSessions.rename(client, {
    channel_id: channelId,
    thread_ts: threadTs,
    title,
  });
}

/**
 * Typed wrappers for the `agents.sessions.*` Web API methods, which are NOT
 * typed in `@slack/web-api` 8.0.0 (they only exist via raw `client.apiCall`).
 *
 * This module is the only sanctioned way to call them. The point is the
 * `status` enum: sending free text ("Thinking...") is rejected by Slack with
 * `invalid_arguments` — `must be a valid enum value [json-pointer:/status]` —
 * and that shipped once because the call site was an untyped `apiCall`.
 *
 * Docs: https://docs.slack.dev/reference/methods/agents.sessions.setStatus
 *       https://docs.slack.dev/reference/methods/agents.sessions.rename
 */
import type { WebAPICallResult, WebClient } from "@slack/web-api";

/** The ONLY values `agents.sessions.setStatus` accepts. */
export type AgentSessionStatus = "suspended" | "processing" | "active" | "closed";

export interface AgentsSessionsSetStatusArguments {
  channel_id: string;
  thread_ts: string;
  status: AgentSessionStatus;
  /** Session title — applies only when this call creates the session. */
  title?: string;
  /** Applies only when this call creates the session. */
  initiator_user_id?: string;
  icon_emoji?: string;
  icon_url?: string;
  username?: string;
}

export interface AgentsSessionsRenameArguments {
  channel_id: string;
  thread_ts: string;
  /** The method takes `title` (not `name`). Max 200 chars. */
  title: string;
}

export const AGENT_SESSION_TITLE_MAX_CHARS = 200;

export type AgentsSessionsResponse = WebAPICallResult & { ok: boolean; error?: string };

/**
 * Error codes for which a channel will never work with sessions — the only
 * ones worth tripping a per-channel circuit breaker on. Everything else
 * (`ratelimited`, `internal_error`, `invalid_arguments` from a bad payload…)
 * is per-call and must NOT disable the loading UX for the channel forever.
 */
export const SESSION_UNSUPPORTED_ERROR_CODES: ReadonlySet<string> = new Set([
  "feature_disabled",
  "channel_type_not_supported",
  "thread_ts_not_allowed",
  "not_in_channel",
  "no_permission",
  "channel_not_found",
]);

export const agentsSessions = {
  setStatus(
    client: WebClient,
    args: AgentsSessionsSetStatusArguments,
  ): Promise<AgentsSessionsResponse> {
    return client.apiCall("agents.sessions.setStatus", { ...args }) as Promise<AgentsSessionsResponse>;
  },
  rename(
    client: WebClient,
    args: AgentsSessionsRenameArguments,
  ): Promise<AgentsSessionsResponse> {
    const title =
      args.title.length <= AGENT_SESSION_TITLE_MAX_CHARS
        ? args.title
        : `${args.title.slice(0, AGENT_SESSION_TITLE_MAX_CHARS - 1)}…`;
    return client.apiCall("agents.sessions.rename", { ...args, title }) as Promise<AgentsSessionsResponse>;
  },
} as const;

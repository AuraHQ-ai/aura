# Slack `agent_view` rollout — completed

Tracking issue: [#1345](https://github.com/AuraHQ-ai/aura/issues/1345)

The `assistant_view` → `agent_view` migration is **done**:

- The Slack app manifest was flipped to `agent_view` on **Aug 26, 2026**
  (00:11 CEST). The flip is a **one-way door** — the legacy
  `assistant.threads.*` experience cannot be restored.
- Verification passed: `agents.sessions.setStatus` / `agents.sessions.rename`
  succeed, and sidebar session rename works end-to-end.
- The `SLACK_AGENT_VIEW` feature flag and all legacy `assistant_view` code
  paths (the `assistant_thread_started` bootstrap and the
  `assistant.threads.setStatus` / `setTitle` / `setSuggestedPrompts` calls)
  were removed in [#1347](https://github.com/AuraHQ-ai/aura/pull/1347).
  **The flag rollback lever no longer exists** — since
  the manifest flip cannot be undone, there is nothing left to roll back to.

Remaining follow-up: adopt typed `agents.sessions.*` methods when
`@slack/web-api` ships them (they are called via raw `client.apiCall(...)`
today).

## Regression found post-cutover (Aug 27, 2026)

The cutover exposed two behavioral contracts of `agents.sessions.setStatus`
that differ from the legacy `assistant.threads.setStatus`, verified live
against the Slack API:

1. **`status` is an enum, not free text.** The only accepted values are
   `"suspended" | "processing" | "active" | "closed"`
   ([method reference](https://docs.slack.dev/reference/methods/agents.sessions.setStatus)).
   Our legacy payloads (`"Thinking..."`, `"Thinking deeply..."`) were rejected
   with `invalid_arguments` (`must be a valid enum value [json-pointer:/status]`)
   on every call. Because the helper soft-fails by adding the channel to the
   `setStatusUnsupportedChannels` circuit breaker, the loading indicator was
   silently and permanently disabled per channel — users saw NO loading UX
   between sending a message and the first streamed chunk.
2. **The loading UX no longer auto-clears.** Per
   [the agent developer guide](https://docs.slack.dev/ai/developing-agents),
   posting a message does not dismiss the loading state under agent_view. The
   app must set `status: "active"` when the turn finishes, or the session
   stays in `processing` until Slack times it out after one hour.

Fix (same PR as the flag removal, [#1347](https://github.com/AuraHQ-ai/aura/pull/1347)):
the helper is now `trySetAgentSessionStatus` with a compile-time
`SessionStatus` enum; the pipeline sets `"processing"` at turn start and
guarantees `"active"` at end of turn (finally-style, on success and error
paths, in both the in-process and durable-workflow respond paths). The
mid-stream `"Thinking deeply..."` update was removed — there is no
expressible equivalent through the enum.

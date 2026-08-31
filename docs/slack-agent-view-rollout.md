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

## Stop button (Aug 27, 2026) — manifest change REQUIRED

Under `agent_view` the Stop button in the Slack UI does **not** cancel anything
by itself. Slack halts the streaming message and emits an
[`agent_session_stopped`](https://docs.slack.dev/reference/events/agent_session_stopped)
event; the app must stop its own generation and move the session out of
`processing` (the status never updates automatically).

Every `agents.sessions.setStatus` call has been warning
`missing_agent_session_stopped_event_subscription` — the manifest (Slack app
dashboard, not this repo) is missing the subscription, so the event never
reached us and pressing Stop was a no-op. Add it:

```yaml
settings:
  event_subscriptions:
    bot_events:
      - agent_session_stopped   # ← add (scope: chat:write, already granted)
```

Handler (`apps/api/src/app.ts`, `/api/slack/events`):

1. `stopInvocation(channel, thread_ts)` writes a `stop:` sentinel into
   `conversation_locks.invocation_id` (without advancing `message_ts`). Every
   in-flight invocation for that thread fails its next `isInvocationCurrent()`
   check — the in-process path at its next `prepareStep`, the durable workflow
   at its next step — and unwinds through the superseded path, appending
   `_[stopped]_` instead of `_[interrupted — new message received]_`
   (`getSupersedeReason()`). The user's next message still claims the lock
   normally because its ts is newer.
2. `agents.sessions.setStatus("active")` immediately, so the spinner clears
   even before the turn unwinds.

Event payload used: `channel`, `thread_ts`, `event_ts`, `user`,
`streaming_message_ts[]` (the messages Slack already halted).

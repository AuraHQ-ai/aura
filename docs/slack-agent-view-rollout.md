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
  were removed in <PR#>. **The flag rollback lever no longer exists** — since
  the manifest flip cannot be undone, there is nothing left to roll back to.

Remaining follow-up: adopt typed `agents.sessions.*` methods when
`@slack/web-api` ships them (they are called via raw `client.apiCall(...)`
today).

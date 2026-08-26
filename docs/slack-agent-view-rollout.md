# Slack `agent_view` rollout runbook

Tracking issue: [#1345](https://github.com/AuraHQ-ai/aura/issues/1345)

Slack's Aug 20, 2026 platform release made Agent Sessions (`agent_view`) the
strategic direction. `assistant_view` is deprecated with a **February 2027
sunset**, and the dashboard manifest switch is a **one-way door**: once an app
is flipped to `agent_view`, the legacy `assistant.threads.*` experience cannot
be restored, and `agents.sessions.*` calls fail while the app is still on
`assistant_view`.

Because the app manifest lives in the api.slack.com dashboard (NOT in this
repo), the migration is split into independent, individually-reversible steps
coordinated by one runtime flag:

- **Flag**: `SLACK_AGENT_VIEW` — values `on` / `off`, default `off`.
- **Single source of truth** for both the wired event listeners
  (`assistant_thread_started` vs `app_home_opened`) and the outbound call
  paths (`assistant.threads.setStatus`/`setTitle` vs
  `agents.sessions.setStatus`/`rename`).
- **`off` = byte-identical to pre-migration behavior.** Instant rollback of
  the code paths = unset the flag (the dashboard flip itself cannot be rolled
  back — see step 3).

## What the flag switches

| Concern | `off` (default) | `on` |
| --- | --- | --- |
| Thread bootstrap trigger | `assistant_thread_started` event | `app_home_opened` event with `tab === "messages"` |
| Suggested prompts | `assistant.threads.setSuggestedPrompts` at runtime | none at runtime — static config in the app dashboard |
| Status | `assistant.threads.setStatus` | `client.apiCall("agents.sessions.setStatus", { channel_id, thread_ts, status })` |
| Title | `assistant.threads.setTitle` | `client.apiCall("agents.sessions.rename", { channel_id, thread_ts, title })` |

The `agents.sessions.*` methods are untyped in `@slack/web-api` 8.0.0, so the
`on` branch uses raw `client.apiCall(...)` — the sanctioned workaround until
typed methods ship. Payload field names verified against
[agents.sessions.setStatus](https://docs.slack.dev/reference/methods/agents.sessions.setstatus)
and [agents.sessions.rename](https://docs.slack.dev/reference/methods/agents.sessions.rename)
(note: rename takes `title`, and both methods take `thread_ts`).

All failure paths on both branches are soft-fail (log + disable-for-channel /
log + continue). A failing status or rename never breaks message delivery.

## Rollout order — follow exactly

1. **Merge this PR / deploy code.** `SLACK_AGENT_VIEW` is unset in all
   environments, so behavior is unchanged. Verify a normal Slack DM
   conversation works (status shows, DM thread titles set).

2. **Prepare the dashboard BEFORE flipping.** In
   [api.slack.com/apps](https://api.slack.com/apps) → Aura → **Agents**:
   - Set the **default suggested prompts** as static config. Runtime
     `setSuggestedPrompts` calls are removed under `agent_view` (see the
     `TODO(agent-view)` in `apps/api/src/slack/thread-bootstrap.ts`) — if you
     skip this, users get no prompts after the flip. Mirror the current
     runtime prompts: "Catch me up", "Run a query", "Search Slack",
     "What do you know?".
   - Verify `agent_view` readiness: required scopes present (the
     `agents.sessions.*` methods require `chat:write`; `assistant:write`
     stays for the not-yet-flipped legacy methods) and event subscriptions
     include `app_home_opened`.

3. **Flip the dashboard to `agent_view`.** This is the one-way door — do it
   only after step 2 is complete. From this moment the code MUST move to the
   flag-on paths quickly: `assistant_thread_started` stops firing and the
   compatibility bridge for `assistant.threads.*` is not guaranteed for a
   flipped app.

4. **Deploy with `SLACK_AGENT_VIEW=on`.**

   ```bash
   printf '%s' 'on' | npx --yes vercel@50.13.2 env add SLACK_AGENT_VIEW production --scope realadvisor
   npx --yes vercel@50.13.2 --prod --scope realadvisor
   ```

   Rollback of the code paths = remove the env var and redeploy (this only
   helps for issues in the new code paths; it does not un-flip the dashboard).

5. **Verify:**
   - Open the Aura DM → Messages tab: dashboard-configured suggested prompts
     appear; `app_home_opened` bootstrap fires (check logs, no
     `app_home_opened_bootstrap` errors).
   - Send a message: session status appears while Aura works
     (`agents.sessions.setStatus`), the native stop button shows, and no
     "agents.sessions.setStatus failed; disabling for channel" warnings are
     logged.
   - After the first response in a fresh DM thread: session title is set
     (`agents.sessions.rename`; "Set initial DM thread title" in logs).
   - Error dashboard: no new `assistant_thread_started` /
     `app_home_opened_bootstrap` / pipeline error spikes.

6. **File the follow-up cleanup issue** (once live and stable) and reference
   it here: remove the flag, the `assistant_thread_started` handler, and the
   `assistant.threads.*` branches; adopt typed `agents.sessions.*` methods
   when `@slack/web-api` ships them.
   - Follow-up issue: _to be filed once live_.

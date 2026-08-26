import type { WebClient } from "@slack/web-api";
import { isSlackAgentViewEnabled } from "../lib/slack-agent-view.js";

/**
 * Shared thread-bootstrap logic for new assistant conversations, used by both
 * event entry points (see app.ts):
 * - `assistant_thread_started` — legacy assistant_view (SLACK_AGENT_VIEW=off)
 * - `app_home_opened` with `tab === "messages"` — agent_view (flag `on`)
 *
 * The flag branch lives here (single source of truth) so the wiring in app.ts
 * only decides WHICH event triggers a bootstrap, never HOW it behaves.
 */
export async function bootstrapAssistantThread(params: {
  client: WebClient;
  channelId?: string;
  threadTs?: string;
}): Promise<void> {
  const { client, channelId, threadTs } = params;
  if (!channelId) return;

  if (isSlackAgentViewEnabled()) {
    // TODO(agent-view): `assistant.threads.setSuggestedPrompts` does not exist
    // under agent_view — suggested prompts became static configuration in the
    // Slack app dashboard (api.slack.com/apps → Aura → Agents → default
    // prompts). Whoever flips the dashboard toggle must also set the default
    // prompts there (docs/slack-agent-view-rollout.md, step 2). Nothing to do
    // at runtime for now; this hook exists so future agent-session bootstrap
    // work has one place to live.
    return;
  }

  if (!threadTs) return;
  await client.assistant.threads.setSuggestedPrompts({
    channel_id: channelId,
    thread_ts: threadTs,
    title: "How can I help?",
    prompts: [
      { title: "Catch me up", message: "What happened in my channels while I was away?" },
      { title: "Run a query", message: "Show me this week's key metrics from BigQuery" },
      { title: "Search Slack", message: "Find recent messages about..." },
      { title: "What do you know?", message: "What do you know about me?" },
    ],
  });
}

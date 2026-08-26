import type { WebClient } from "@slack/web-api";

/**
 * Thread-bootstrap hook for new agent-session conversations, triggered by
 * `app_home_opened` with `tab === "messages"` (see app.ts).
 *
 * Under agent_view there is nothing to do at runtime: suggested prompts are
 * static configuration in the Slack app dashboard (api.slack.com/apps → Aura
 * → Agents → default prompts), and `assistant.threads.setSuggestedPrompts`
 * no longer exists. This hook is kept so future agent-session bootstrap work
 * has one place to live.
 */
export async function bootstrapAssistantThread(params: {
  client: WebClient;
  channelId?: string;
}): Promise<void> {
  if (!params.channelId) return;
  // No runtime bootstrap needed under agent_view (see doc comment above).
}

/**
 * Feature flag for the Slack `assistant_view` → `agent_view` migration
 * (issue #1345).
 *
 * The Slack app manifest lives in the api.slack.com dashboard, not in this
 * repo, and flipping it to `agent_view` is a one-way door: `agents.sessions.*`
 * calls fail against an `assistant_view` app and vice versa. This flag is the
 * single source of truth for BOTH the wired event listeners and the outbound
 * call paths, so code can merge first, the dashboard flip happens second, and
 * env activation third — with instant rollback by unsetting the flag.
 *
 * Values: `on` / `off` (default `off`). Read at call time (not module load)
 * so the flag can be flipped per-deploy and toggled in tests.
 *
 * Rollout order: see docs/slack-agent-view-rollout.md.
 */
export function isSlackAgentViewEnabled(): boolean {
  return (process.env.SLACK_AGENT_VIEW ?? "").trim().toLowerCase() === "on";
}

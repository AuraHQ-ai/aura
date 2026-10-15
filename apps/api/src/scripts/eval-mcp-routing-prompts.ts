/**
 * Suggested eval harness for MCP server routing (issue #1553).
 *
 * Do not claim the `<mcp_servers>` hint block helps until this (or an equivalent)
 * is run with and without the block. Record, for each prompt, whether the first
 * tool-search / MCP tool call targeted the expected slug.
 *
 * Suggested run:
 *   1. Pick a caller who has live `close_fr`, `close_es`, and `mako` connections.
 *   2. Run each prompt twice — once with the hint block in the system prompt,
 *      once with it stripped — against the same model.
 *   3. Score: 1 if the first MCP interaction is `mcp__<expectedSlug>__*`, else 0.
 */

export interface McpRoutingEvalCase {
  id: string;
  prompt: string;
  expectedSlug: string;
}

export const MCP_ROUTING_EVAL_CASES: McpRoutingEvalCase[] = [
  {
    id: "fr-sales-week",
    prompt: "How many sales in France this week?",
    expectedSlug: "close_fr",
  },
  {
    id: "fr-pipeline",
    prompt: "What's the Close pipeline value for the French team right now?",
    expectedSlug: "close_fr",
  },
  {
    id: "fr-won-today",
    prompt: "Which deals did we win in France today?",
    expectedSlug: "close_fr",
  },
  {
    id: "es-sales-week",
    prompt: "How many sales in Spain this week?",
    expectedSlug: "close_es",
  },
  {
    id: "es-leads",
    prompt: "Show me new Spanish leads from Close in the last 7 days.",
    expectedSlug: "close_es",
  },
  {
    id: "es-stale",
    prompt: "Which Spain Close opportunities have gone stale?",
    expectedSlug: "close_es",
  },
  {
    id: "mako-traffic",
    prompt: "What was site traffic in Mako yesterday?",
    expectedSlug: "mako",
  },
  {
    id: "mako-funnel",
    prompt: "Break down the Mako conversion funnel for the last 7 days.",
    expectedSlug: "mako",
  },
  {
    id: "mako-listing",
    prompt: "How many listings were published in Mako this week?",
    expectedSlug: "mako",
  },
  {
    id: "fr-vs-bq",
    prompt: "Don't use BigQuery. How many Close opportunities closed in France since Monday?",
    expectedSlug: "close_fr",
  },
  {
    id: "fr-activity",
    prompt: "Summarize Close activity for the French AEs today.",
    expectedSlug: "close_fr",
  },
  {
    id: "es-forecast",
    prompt: "What's the Spain Close forecast for this month?",
    expectedSlug: "close_es",
  },
  {
    id: "mako-geo",
    prompt: "Which Mako geos had the biggest drop in sessions this week?",
    expectedSlug: "mako",
  },
  {
    id: "fr-call",
    prompt: "Did anyone in France log a Close call this morning?",
    expectedSlug: "close_fr",
  },
  {
    id: "es-email",
    prompt: "How many emails did the Spain Close team send yesterday?",
    expectedSlug: "close_es",
  },
];

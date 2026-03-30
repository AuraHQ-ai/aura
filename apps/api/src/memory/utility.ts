/**
 * Maps LLM-judged utility labels to numeric scores.
 * These scores become the initial `relevanceScore` for a memory,
 * which then decays over time via the daily consolidation cron.
 */
const UTILITY_SCORES: Record<string, number> = {
  high: 1.0,
  medium: 0.7,
  low: 0.3,
};

export function utilityToScore(utility: string | null | undefined): number {
  if (!utility) return 0.7;
  return UTILITY_SCORES[utility] ?? 0.7;
}

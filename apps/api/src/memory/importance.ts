/**
 * Converts an importance score (1-100) to the initial relevanceScore (0-1).
 * relevanceScore then decays over time via the daily consolidation cron.
 */
export function importanceToRelevance(importance: number | null | undefined): number {
  if (importance == null || importance <= 0) return 0.5;
  return Math.min(1.0, Math.max(0.01, importance / 100));
}

/**
 * Importance threshold below which memories are discarded at extraction time.
 * Memories scoring below this are operational noise not worth storing.
 */
export const IMPORTANCE_DISCARD_THRESHOLD = 20;

export const DECAY_FACTOR = 0.995;

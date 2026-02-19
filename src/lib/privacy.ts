import type { Memory } from "../db/schema.js";

/**
 * Previously filtered DM-sourced memories by related_user_ids / shareable.
 * Now returns all memories unfiltered — this is a corporate tool where
 * full transparency is the policy. The related_user_ids column is kept in
 * the schema as a useful index ("show me everything about person X") but
 * is no longer used as an access gate.
 */
export function filterMemoriesByPrivacy(
  memories: Memory[],
  _currentUserId: string,
): Memory[] {
  return memories;
}

import type { Memory } from "@aura/db/schema";

/**
 * Filter memories by DM privacy rules (FR-2.4).
 *
 * Rules:
 * - Memories from public/private channels pass through (shared knowledge).
 * - Memories sourced from DMs are only included if:
 *   1. The current user is in `relatedUserIds` (it's their own DM), OR
 *   2. The memory was explicitly marked as `shareable` during extraction
 *      (e.g., user said "Tell Maria that I approved the budget").
 */
export function filterMemoriesByPrivacy(
  memories: Memory[],
  currentUserId: string,
): Memory[] {
  return memories.filter((memory) => {
    // Channel-sourced memories are always visible
    if (memory.sourceChannelType !== "dm") {
      return true;
    }

    // DM memory: only visible to related users or if shareable
    if (memory.relatedUserIds.includes(currentUserId)) {
      return true;
    }

    if (memory.shareable === 1) {
      return true;
    }

    return false;
  });
}

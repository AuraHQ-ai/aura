/**
 * Shared permission utilities.
 * The single source of truth for admin checks across the codebase.
 */

/** Check whether a Slack user ID is in the AURA_ADMIN_USER_IDS env var. */
export function isAdmin(userId: string | undefined): boolean {
  if (!userId) return false;
  const adminIds = (process.env.AURA_ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (adminIds.length === 0) return false;
  return adminIds.includes(userId);
}

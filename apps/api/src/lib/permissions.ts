import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { userProfiles } from "@aura/db/schema";

const ROLE_HIERARCHY = {
  member: 0,
  power_user: 1,
  admin: 2,
  owner: 3,
} as const;

type Role = keyof typeof ROLE_HIERARCHY;

/**
 * Check whether a user has at least the specified role.
 * Falls back to AURA_ADMIN_USER_IDS env var during migration period.
 */
export async function hasRole(
  userId: string | undefined,
  minimumRole: Role = "admin"
): Promise<boolean> {
  if (!userId) return false;

  if (userId === "aura") return true;

  try {
    const profile = await db
      .select({ role: userProfiles.role })
      .from(userProfiles)
      .where(eq(userProfiles.slackUserId, userId))
      .limit(1);

    if (profile.length > 0 && profile[0].role) {
      const userLevel = ROLE_HIERARCHY[profile[0].role as Role] ?? 0;
      const requiredLevel = ROLE_HIERARCHY[minimumRole];
      return userLevel >= requiredLevel;
    }
  } catch {
    // DB query failed — fall through to env var fallback
  }

  const adminIds = (process.env.AURA_ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (adminIds.includes(userId)) {
    const requiredLevel = ROLE_HIERARCHY[minimumRole];
    return ROLE_HIERARCHY.admin >= requiredLevel;
  }

  return false;
}

/**
 * Backwards-compatible sync wrapper.
 * DEPRECATED: Use hasRole() instead. Kept for call sites that can't easily go async.
 * Still reads from env var only.
 */
export function isAdmin(userId: string | undefined): boolean {
  if (!userId) return false;
  if (userId === "aura") return true;
  const adminIds = (process.env.AURA_ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return adminIds.includes(userId);
}

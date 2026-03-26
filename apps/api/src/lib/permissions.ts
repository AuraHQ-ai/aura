import { eq, isNull, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { userProfiles, credentials, credentialGrants, oauthTokens } from "@aura/db/schema";
import { executionContext } from "./tool.js";
import { logger } from "./logger.js";

const ROLE_HIERARCHY = {
  member: 0,
  power_user: 1,
  admin: 2,
  owner: 3,
} as const;

type Role = keyof typeof ROLE_HIERARCHY;

/**
 * Resolve the calling user's Slack ID.
 *
 * Primary source: `executionContext` (AsyncLocalStorage), set once at
 * the Slack event / job entry point from `event.user` or `job.requestedBy`.
 * Fallback: the explicitly passed `userId` (for contexts without
 * AsyncLocalStorage, e.g. the dashboard).
 */
function resolveCallingUserId(passedUserId: string | undefined): string | undefined {
  const ctx = executionContext.getStore();
  if (ctx?.callingUserId) return ctx.callingUserId;
  return passedUserId;
}

/**
 * Check whether a user has at least the specified role.
 * Falls back to AURA_ADMIN_USER_IDS env var during migration period.
 *
 * The userId is resolved via resolveCallingUserId(): the execution
 * context's callingUserId takes priority over the passed parameter so
 * that permission checks always use the human caller's ID, not the
 * bot's.
 */
export async function hasRole(
  userId: string | undefined,
  minimumRole: Role = "admin"
): Promise<boolean> {
  const effectiveUserId = resolveCallingUserId(userId);

  if (!effectiveUserId) return false;

  if (effectiveUserId === "aura") return true;

  if (effectiveUserId !== userId && userId) {
    logger.warn("hasRole: overriding userId from execution context", {
      passed: userId,
      effective: effectiveUserId,
      minimumRole,
    });
  }

  try {
    const profile = await db
      .select({ role: userProfiles.role })
      .from(userProfiles)
      .where(eq(userProfiles.slackUserId, effectiveUserId))
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
  if (adminIds.includes(effectiveUserId)) {
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

/**
 * Look up a user's role from the DB. Returns 'member' if not found.
 */
async function getUserRole(userId: string): Promise<Role> {
  if (userId === "aura") return "owner";

  try {
    const profile = await db
      .select({ role: userProfiles.role })
      .from(userProfiles)
      .where(eq(userProfiles.slackUserId, userId))
      .limit(1);
    if (profile.length > 0 && profile[0].role) {
      return profile[0].role as Role;
    }
  } catch {
    // fall through
  }

  const adminIds = (process.env.AURA_ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (adminIds.includes(userId)) {
    return "admin";
  }

  return "member";
}

/**
 * Resolve the set of credential *names* a user can access.
 *
 * Credential scope uses the role hierarchy directly:
 * - 'member' -> everyone can access
 * - 'power_user' -> power_user, admin, owner
 * - 'admin' -> admin, owner
 * - 'owner' -> owner only
 * - 'per_user' -> only the credential owner
 *
 * Plus explicit grants and synthetic env-var-based credentials.
 */
export async function resolveUserCredentials(
  userId?: string,
): Promise<Set<string>> {
  const effectiveUserId = resolveCallingUserId(userId);
  const result = new Set<string>();

  if (!effectiveUserId) return result;

  const userRole = await getUserRole(effectiveUserId);
  const userLevel = ROLE_HIERARCHY[userRole] ?? 0;

  // Synthetic credentials from env vars (not yet stored in DB)
  // Power-user+ tools: sandbox, browser, cursor agent, voice, web search
  if (userLevel >= ROLE_HIERARCHY.power_user) {
    if (process.env.E2B_API_KEY) result.add("e2b_api_key");
    if (process.env.BROWSERBASE_API_KEY) result.add("browserbase_api_key");
    if (process.env.CURSOR_API_KEY) result.add("cursor_api_key");
    if (process.env.ELEVENLABS_API_KEY) result.add("elevenlabs_api_key");
    if (process.env.TAVILY_API_KEY) result.add("tavily_api_key");
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      result.add("twilio_credentials");
    }
    if (process.env.GOOGLE_BQ_CREDENTIALS || process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      result.add("google_bq_credentials");
    }
  }

  // Admin-only synthetic: only admins get these "virtual" credentials
  if (userLevel >= ROLE_HIERARCHY.admin) {
    result.add("admin_access");
  }

  try {
    const allCreds = await db
      .select({ name: credentials.name, scope: credentials.scope, ownerId: credentials.ownerId })
      .from(credentials);

    for (const cred of allCreds) {
      const scope = (cred.scope || "member") as Role | "per_user";
      if (scope === "per_user") {
        // Only the credential owner gets it
        if (cred.ownerId === effectiveUserId) {
          result.add(cred.name);
        }
      } else {
        // Role-based scope: user needs at least this role
        const requiredLevel = ROLE_HIERARCHY[scope as Role] ?? 0;
        if (userLevel >= requiredLevel) {
          result.add(cred.name);
        }
      }
    }

    // Explicit grants always work regardless of scope
    const grants = await db
      .select({ credentialName: credentials.name })
      .from(credentialGrants)
      .innerJoin(credentials, eq(credentialGrants.credentialId, credentials.id))
      .where(
        and(
          eq(credentialGrants.granteeId, effectiveUserId),
          isNull(credentialGrants.revokedAt),
        ),
      );

    for (const grant of grants) {
      result.add(grant.credentialName);
    }
  } catch (e: any) {
    logger.warn("resolveUserCredentials: DB query failed, returning env-based credentials only", {
      userId: effectiveUserId,
      error: e.message,
    });
  }

  // google_oauth: check if user has OAuth tokens (synthetic per-user credential)
  try {
    const tokens = await db
      .select({ id: oauthTokens.id })
      .from(oauthTokens)
      .where(eq(oauthTokens.userId, effectiveUserId))
      .limit(1);
    if (tokens.length > 0) {
      result.add("google_oauth");
    }
    // Admins can manage all users' email
    if (userLevel >= ROLE_HIERARCHY.admin) {
      result.add("google_oauth");
    }
  } catch {
    // oauthTokens table may not exist yet; skip
  }

  return result;
}

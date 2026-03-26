import { createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { userProfiles } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, createDashboardApp } from "./schemas.js";
import { SignJWT } from "jose";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import crypto from "node:crypto";

function getSessionSecret(): Uint8Array {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!secret) throw new Error("DASHBOARD_SESSION_SECRET not configured");
  return new TextEncoder().encode(secret);
}

export async function createSessionJwt(payload: { slackUserId: string; name: string; picture: string }): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSessionSecret());
}

export const dashboardAuthApp = createDashboardApp();

const ALLOWED_ROLES = ["owner", "admin", "power_user"];

/**
 * Check if a Slack user is allowed to access the dashboard.
 * If no owner exists yet, bootstraps the first user as owner.
 */
export async function checkUserRole(
  slackUserId: string,
  name?: string,
): Promise<{ allowed: boolean; role?: string; reason?: string; bootstrapped?: boolean }> {
  const existing = await db
    .select({ role: userProfiles.role })
    .from(userProfiles)
    .where(eq(userProfiles.slackUserId, slackUserId))
    .limit(1);

  if (existing.length > 0) {
    const role = existing[0].role;
    if (ALLOWED_ROLES.includes(role)) {
      return { allowed: true, role };
    }
    return { allowed: false, reason: "insufficient_role", role };
  }

  const bootstrapResult = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(42)`);

    const ownerCount = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(userProfiles)
      .where(eq(userProfiles.role, "owner"));

    if ((ownerCount[0]?.count ?? 0) > 0) {
      return null;
    }

    const inserted = await tx
      .insert(userProfiles)
      .values({
        slackUserId,
        displayName: name || "Owner",
        role: "owner",
      })
      .onConflictDoUpdate({
        target: [userProfiles.workspaceId, userProfiles.slackUserId],
        set: { role: "owner", updatedAt: new Date() },
      })
      .returning({ role: userProfiles.role });

    return inserted[0]?.role ?? "owner";
  });

  if (bootstrapResult) {
    logger.info("Auto-seeded first user as owner", { slackUserId });
    return { allowed: true, role: bootstrapResult, bootstrapped: true };
  }

  return { allowed: false, reason: "no_profile" };
}

// ── POST /check-role ─────────────────────────────────────────────────────────

const checkRoleRoute = createRoute({
  method: "post",
  path: "/check-role",
  tags: ["Auth"],
  summary: "Check user role and bootstrap first owner",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            slackUserId: z.string(),
            name: z.string().optional(),
            picture: z.string().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            allowed: z.boolean(),
            role: z.string().optional(),
            reason: z.string().optional(),
            bootstrapped: z.boolean().optional(),
          }),
        },
      },
      description: "Role check result",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Bad request",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardAuthApp.openapi(checkRoleRoute, async (c) => {
  try {
    const body = await c.req.json<{
      slackUserId: string;
      name?: string;
      picture?: string;
    }>();

    const { slackUserId, name } = body;
    if (!slackUserId) {
      return c.json({ error: "slackUserId is required" }, 400);
    }

    const result = await checkUserRole(slackUserId, name);
    return c.json(result as any, 200);
  } catch (error) {
    logger.error("Failed to check role", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── Slack OIDC Login (direct, no proxy) ──────────────────────────────────────

function getBaseUrl(c: { req: { url: string; header: (name: string) => string | undefined } }): string {
  const proto = c.req.header("x-forwarded-proto") || "https";
  const host = c.req.header("x-forwarded-host") || c.req.header("host") || new URL(c.req.url).host;
  return `${proto}://${host}`;
}

/** Allow HTTPS origins and localhost (HTTP or HTTPS). */
function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost")
      return url.protocol === "http:" || url.protocol === "https:";
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function getSafeReturnTo(returnTo: string | null | undefined): string {
  if (!returnTo || !returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.startsWith("/api/auth")) {
    return "/";
  }
  return returnTo;
}

dashboardAuthApp.get("/login", async (c) => {
  const returnTo = c.req.query("returnTo") || "/";
  const rawOrigin = c.req.query("origin");
  const baseUrl = getBaseUrl(c);
  const origin = rawOrigin && isAllowedOrigin(rawOrigin) ? rawOrigin : baseUrl;

  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    logger.error("SLACK_CLIENT_ID not configured");
    return c.redirect(`${origin}/unauthorized?reason=config_error`);
  }

  const nonce = crypto.randomBytes(16).toString("hex");

  setCookie(c, "oauth_state", nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 300,
    path: "/",
  });

  const state = Buffer.from(
    JSON.stringify({ nonce, origin, returnTo }),
  ).toString("base64url");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: "openid profile email",
    redirect_uri: `${baseUrl}/api/dashboard/auth/callback`,
    state,
    nonce: crypto.randomBytes(16).toString("hex"),
  });

  return c.redirect(`https://slack.com/openid/connect/authorize?${params.toString()}`);
});

// ── Slack OIDC Callback ──────────────────────────────────────────────────────

dashboardAuthApp.get("/callback", async (c) => {
  const code = c.req.query("code");
  const stateParam = c.req.query("state");
  const baseUrl = getBaseUrl(c);

  const savedNonce = getCookie(c, "oauth_state");
  deleteCookie(c, "oauth_state", { path: "/" });

  let nonce: string | undefined;
  let origin: string | undefined;
  let returnTo: string | undefined;

  try {
    const decoded = JSON.parse(
      Buffer.from(stateParam || "", "base64url").toString(),
    );
    nonce = decoded.nonce;
    origin = decoded.origin;
    returnTo = getSafeReturnTo(decoded.returnTo);
  } catch {
    return c.redirect(`${baseUrl}/unauthorized?reason=invalid_state`);
  }

  const redirectBase = origin || baseUrl;

  if (!code || !nonce || nonce !== savedNonce) {
    return c.redirect(`${redirectBase}/unauthorized?reason=invalid_state`);
  }

  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    logger.error("Slack OAuth credentials not configured");
    return c.redirect(`${redirectBase}/unauthorized?reason=config_error`);
  }

  const tokenRes = await fetch("https://slack.com/api/openid.connect.token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${baseUrl}/api/dashboard/auth/callback`,
    }),
  });

  const tokenData = await tokenRes.json() as { ok: boolean; access_token?: string };
  if (!tokenData.ok || !tokenData.access_token) {
    logger.warn("Slack token exchange failed", { tokenData });
    return c.redirect(`${redirectBase}/unauthorized?reason=token_error`);
  }

  const userInfoRes = await fetch("https://slack.com/api/openid.connect.userInfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const userInfo = await userInfoRes.json() as Record<string, unknown>;
  if (!userInfo.ok) {
    logger.warn("Slack userInfo failed", { userInfo });
    return c.redirect(`${redirectBase}/unauthorized?reason=userinfo_error`);
  }

  const slackUserId = (userInfo["https://slack.com/user_id"] || userInfo.sub) as string;
  const name = (userInfo.name as string) || "Admin";
  const picture = (userInfo.picture as string) || "";

  try {
    const roleResult = await checkUserRole(slackUserId, name);
    if (!roleResult.allowed) {
      return c.redirect(`${redirectBase}/unauthorized?reason=not_admin`);
    }
  } catch (err) {
    logger.error("Role check failed during OAuth callback", { error: String(err) });
    return c.redirect(`${redirectBase}/unauthorized?reason=check_failed`);
  }

  const jwt = await createSessionJwt({ slackUserId, name, picture });

  const safeReturnTo = getSafeReturnTo(returnTo);
  const separator = safeReturnTo.includes("?") ? "&" : "?";
  return c.redirect(`${redirectBase}${safeReturnTo}${separator}token=${jwt}`);
});

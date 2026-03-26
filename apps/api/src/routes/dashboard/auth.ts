import { createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { userProfiles } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, createDashboardApp } from "./schemas.js";
import { SignJWT, jwtVerify } from "jose";
import crypto from "node:crypto";

const PRODUCTION_URL = "https://app.aurahq.ai";

function getSessionSecret(): Uint8Array {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!secret) throw new Error("DASHBOARD_SESSION_SECRET not configured");
  return new TextEncoder().encode(secret);
}

function signOrigin(origin: string): string {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!secret) throw new Error("DASHBOARD_SESSION_SECRET not configured");
  return crypto.createHmac("sha256", Buffer.from(secret, "utf-8")).update(origin).digest("hex");
}

export async function createSessionJwt(payload: { slackUserId: string; name: string; picture: string }): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSessionSecret());
}

export async function verifyTransferToken(token: string): Promise<{ slackUserId: string; name: string; picture: string }> {
  const { payload } = await jwtVerify(token, getSessionSecret());
  if (payload.purpose !== "transfer") throw new Error("Invalid token purpose");
  return {
    slackUserId: payload.slackUserId as string,
    name: payload.name as string,
    picture: payload.picture as string,
  };
}

export const dashboardAuthApp = createDashboardApp();

const ALLOWED_ROLES = ["owner", "admin", "power_user"];

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

    const { slackUserId, name, picture } = body;
    if (!slackUserId) {
      return c.json({ error: "slackUserId is required" }, 400);
    }

    const existing = await db
      .select({ role: userProfiles.role })
      .from(userProfiles)
      .where(eq(userProfiles.slackUserId, slackUserId))
      .limit(1);

    if (existing.length > 0) {
      const role = existing[0].role;
      if (ALLOWED_ROLES.includes(role)) {
        return c.json({ allowed: true, role } as any, 200);
      }
    }

    if (existing.length > 0) {
      return c.json({ allowed: false, reason: "insufficient_role", role: existing[0].role } as any, 200);
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
      return c.json(
        {
          allowed: true,
          role: bootstrapResult,
          bootstrapped: true,
        } as any,
        200,
      );
    }

    return c.json({ allowed: false, reason: "no_profile" } as any, 200);
  } catch (error) {
    logger.error("Failed to check role", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ── Slack OIDC Login (delegates to production proxy for non-prod) ────────────

dashboardAuthApp.get("/login", async (c) => {
  const returnTo = c.req.query("returnTo") || "/";
  const origin = c.req.query("origin") || c.req.header("x-forwarded-origin") || new URL(c.req.url).origin;

  const proxyUrl = new URL(`${PRODUCTION_URL}/api/auth/proxy-login`);
  proxyUrl.searchParams.set("origin", origin);
  proxyUrl.searchParams.set("sig", signOrigin(origin));
  proxyUrl.searchParams.set("returnTo", returnTo);

  return c.redirect(proxyUrl.toString());
});

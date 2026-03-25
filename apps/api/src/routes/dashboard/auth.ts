import { createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { userProfiles } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, createDashboardApp } from "./schemas.js";

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

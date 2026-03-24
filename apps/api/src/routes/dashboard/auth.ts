import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { userProfiles } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";

export const dashboardAuthApp = new Hono();

const ALLOWED_ROLES = ["owner", "admin", "power_user"];

dashboardAuthApp.post("/check-role", async (c) => {
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
        return c.json({ allowed: true, role });
      }
      return c.json({ allowed: false, reason: "insufficient_role", role });
    }

    const ownerCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(userProfiles)
      .where(eq(userProfiles.role, "owner"));

    if ((ownerCount[0]?.count ?? 0) > 0) {
      return c.json({ allowed: false, reason: "no_profile" });
    }

    const inserted = await db
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

    logger.info("Auto-seeded first user as owner", { slackUserId });

    return c.json({
      allowed: true,
      role: inserted[0]?.role ?? "owner",
      bootstrapped: true,
    });
  } catch (error) {
    logger.error("Failed to check role", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

import { Hono } from "hono";
import { eq, sql, ilike, desc } from "drizzle-orm";
import { userProfiles, people, memories } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";

export const dashboardUsersApp = new Hono();

dashboardUsersApp.get("/", async (c) => {
  try {
    const search = c.req.query("search") ?? "";
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10)));
    const offset = (page - 1) * limit;

    const where = search
      ? ilike(userProfiles.displayName, `%${search}%`)
      : undefined;

    const [items, countResult] = await Promise.all([
      db
        .select({
          id: userProfiles.id,
          slackUserId: userProfiles.slackUserId,
          displayName: userProfiles.displayName,
          interactionCount: userProfiles.interactionCount,
          lastInteractionAt: userProfiles.lastInteractionAt,
          createdAt: userProfiles.createdAt,
          personId: userProfiles.personId,
          jobTitle: people.jobTitle,
        })
        .from(userProfiles)
        .leftJoin(people, eq(userProfiles.personId, people.id))
        .where(where)
        .orderBy(sql`${userProfiles.lastInteractionAt} desc nulls last`)
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(userProfiles)
        .where(where),
    ]);

    return c.json({ items, total: countResult[0]?.count ?? 0 });
  } catch (error) {
    logger.error("Failed to list users", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

dashboardUsersApp.get("/:slackUserId", async (c) => {
  try {
    const slackUserId = c.req.param("slackUserId");

    const profileRows = await db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.slackUserId, slackUserId))
      .limit(1);

    if (profileRows.length === 0) {
      return c.json({ error: "User not found" }, 404);
    }

    const profile = profileRows[0];

    let person = null;
    if (profile.personId) {
      const personRows = await db
        .select()
        .from(people)
        .where(eq(people.id, profile.personId))
        .limit(1);
      person = personRows[0] ?? null;
    }

    const userMemories = await db
      .select({
        id: memories.id,
        content: memories.content,
        type: memories.type,
        sourceMessageId: memories.sourceMessageId,
        sourceChannelType: memories.sourceChannelType,
        relatedUserIds: memories.relatedUserIds,
        relevanceScore: memories.relevanceScore,
        shareable: memories.shareable,
        createdAt: memories.createdAt,
        updatedAt: memories.updatedAt,
      })
      .from(memories)
      .where(sql`${memories.relatedUserIds} @> ARRAY[${slackUserId}]::text[]`)
      .orderBy(desc(memories.createdAt))
      .limit(20);

    return c.json({ profile, person, memories: userMemories });
  } catch (error) {
    logger.error("Failed to get user detail", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const VALID_ROLES = ["owner", "admin", "power_user", "member"] as const;

dashboardUsersApp.patch("/:slackUserId/role", async (c) => {
  try {
    const slackUserId = c.req.param("slackUserId");
    const body = await c.req.json<{ role: string }>();

    if (!VALID_ROLES.includes(body.role as (typeof VALID_ROLES)[number])) {
      return c.json(
        { error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` },
        400,
      );
    }

    const result = await db
      .update(userProfiles)
      .set({ role: body.role, updatedAt: new Date() })
      .where(eq(userProfiles.slackUserId, slackUserId))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "User not found" }, 404);
    }

    return c.json(result[0]);
  } catch (error) {
    logger.error("Failed to update user role", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

dashboardUsersApp.patch("/person/:personId", async (c) => {
  try {
    const personId = c.req.param("personId");
    const body = await c.req.json<{
      jobTitle?: string;
      preferredLanguage?: string;
      gender?: string;
      notes?: string;
    }>();

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.jobTitle !== undefined) updates.jobTitle = body.jobTitle;
    if (body.preferredLanguage !== undefined) updates.preferredLanguage = body.preferredLanguage;
    if (body.gender !== undefined) updates.gender = body.gender;
    if (body.notes !== undefined) updates.notes = body.notes;

    const result = await db
      .update(people)
      .set(updates)
      .where(eq(people.id, personId))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "Person not found" }, 404);
    }

    return c.json(result[0]);
  } catch (error) {
    logger.error("Failed to update person", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

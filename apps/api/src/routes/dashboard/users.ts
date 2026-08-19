import { createRoute, z } from "@hono/zod-openapi";
import { eq, sql, ilike, desc } from "drizzle-orm";
import { users, memories } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, paginationQuerySchema, createDashboardApp } from "./schemas.js";

export const dashboardUsersApp = createDashboardApp();

const listUsersRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Users"],
  summary: "List users",
  request: {
    query: paginationQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(z.any()),
            total: z.number(),
          }),
        },
      },
      description: "Success",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardUsersApp.openapi(listUsersRoute, async (c) => {
  try {
    const search = c.req.query("search") ?? "";
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10)));
    const offset = (page - 1) * limit;

    const where = search
      ? ilike(users.displayName, `%${search}%`)
      : undefined;

    const [items, countResult] = await Promise.all([
      db
        .select({
          id: users.id,
          slackUserId: users.slackUserId,
          displayName: users.displayName,
          role: users.role,
          interactionCount: users.interactionCount,
          lastInteractionAt: users.lastInteractionAt,
          createdAt: users.createdAt,
          jobTitle: users.jobTitle,
        })
        .from(users)
        .where(where)
        .orderBy(sql`${users.lastInteractionAt} desc nulls last`)
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(where),
    ]);

    return c.json({ items, total: countResult[0]?.count ?? 0 } as any, 200);
  } catch (error) {
    logger.error("Failed to list users", { error: error instanceof Error ? error.stack : String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const getUserRoute = createRoute({
  method: "get",
  path: "/{slackUserId}",
  tags: ["Users"],
  summary: "Get user detail by Slack user ID",
  request: {
    params: z.object({
      slackUserId: z.string().openapi({ param: { name: "slackUserId", in: "path" } }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardUsersApp.openapi(getUserRoute, async (c) => {
  try {
    const slackUserId = c.req.param("slackUserId");

    const profileRows = await db
      .select()
      .from(users)
      .where(eq(users.slackUserId, slackUserId))
      .limit(1);

    if (profileRows.length === 0) {
      return c.json({ error: "User not found" }, 404);
    }

    const profile = profileRows[0];

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

    const person = {
      id: profile.id,
      jobTitle: profile.jobTitle ?? null,
      preferredLanguage: profile.preferredLanguage ?? null,
      gender: profile.gender ?? null,
      notes: profile.notes ?? null,
    };

    return c.json({ profile, person, memories: userMemories } as any, 200);
  } catch (error) {
    logger.error("Failed to get user detail", { error: error instanceof Error ? error.stack : String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const VALID_ROLES = ["admin", "power_user", "member"] as const;

const updateUserRoleRoute = createRoute({
  method: "patch",
  path: "/{slackUserId}/role",
  tags: ["Users"],
  summary: "Update user role",
  request: {
    params: z.object({
      slackUserId: z.string().openapi({ param: { name: "slackUserId", in: "path" } }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            role: z.string(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Bad request",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardUsersApp.openapi(updateUserRoleRoute, async (c) => {
  try {
    const slackUserId = c.req.param("slackUserId");

    let body: { role: string };
    try {
      body = await c.req.json<{ role: string }>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.role || !VALID_ROLES.includes(body.role as (typeof VALID_ROLES)[number])) {
      return c.json(
        { error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` },
        400,
      );
    }

    const result = await db
      .update(users)
      .set({ role: body.role, updatedAt: new Date() })
      .where(eq(users.slackUserId, slackUserId))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "User not found" }, 404);
    }

    return c.json(result[0] as any, 200);
  } catch (error) {
    logger.error("Failed to update user role", {
      error: error instanceof Error ? error.stack : String(error),
      slackUserId: c.req.param("slackUserId"),
    });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const updatePersonRoute = createRoute({
  method: "patch",
  path: "/person/{userId}",
  tags: ["Users"],
  summary: "Update person details (now stored on users table)",
  request: {
    params: z.object({
      userId: z.string().openapi({ param: { name: "userId", in: "path" } }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            jobTitle: z.string().optional(),
            preferredLanguage: z.string().optional(),
            gender: z.string().optional(),
            notes: z.string().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardUsersApp.openapi(updatePersonRoute, async (c) => {
  try {
    const userId = c.req.param("userId");
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
      .update(users)
      .set(updates)
      .where(eq(users.id, userId))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "User not found" }, 404);
    }

    return c.json(result[0] as any, 200);
  } catch (error) {
    logger.error("Failed to update user person fields", { error: error instanceof Error ? error.stack : String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

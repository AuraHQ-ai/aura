import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, desc, count, sql } from "drizzle-orm";
import { memories, userProfiles } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, idParamSchema } from "./schemas.js";

export const dashboardMemoriesApp = new OpenAPIHono();

const memoryColumns = {
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
} as const;

const listMemoriesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Memories"],
  summary: "List memories",
  request: {
    query: z.object({
      search: z.string().optional(),
      type: z.string().optional(),
      page: z.coerce.number().optional(),
      limit: z.coerce.number().optional(),
    }),
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

dashboardMemoriesApp.openapi(listMemoriesRoute, async (c) => {
  try {
    const search = c.req.query("search");
    const type = c.req.query("type");
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const limit = Math.max(1, Math.min(500, Number(c.req.query("limit")) || 100));
    const offset = (page - 1) * limit;

    if (search) {
      try {
        const { retrieveMemories } = await import("../../memory/retrieve.js");
        const results = await retrieveMemories({
          query: search,
          currentUserId: "dashboard",
          limit,
          adminMode: true,
        });

        let items = results.map(({ embedding, ...rest }) => rest);
        if (type) items = items.filter((m) => m.type === type);
        return c.json({ items, total: items.length } as any, 200);
      } catch {
        logger.warn("Hybrid memory search failed, falling back to full-text");
      }
    }

    const conditions = [];
    if (search) {
      conditions.push(
        sql`to_tsvector('english', coalesce(${memories.content}, '')) @@ plainto_tsquery('english', ${search})`,
      );
    }
    if (type) conditions.push(eq(memories.type, type as any));

    const where = conditions.length > 0
      ? conditions.length === 1
        ? conditions[0]
        : sql`${conditions[0]} AND ${conditions[1]}`
      : undefined;

    const [items, [totalRow]] = await Promise.all([
      db
        .select(memoryColumns)
        .from(memories)
        .where(where)
        .orderBy(desc(memories.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(memories).where(where),
    ]);

    return c.json({ items, total: totalRow.value } as any, 200);
  } catch (error) {
    logger.error("Failed to list memories", { error });
    return c.json({ error: "Failed to list memories" }, 500);
  }
});

const getMemoryRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Memories"],
  summary: "Get memory by ID",
  request: {
    params: idParamSchema,
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

dashboardMemoriesApp.openapi(getMemoryRoute, async (c) => {
  try {
    const id = c.req.param("id");
    const [memory] = await db
      .select(memoryColumns)
      .from(memories)
      .where(eq(memories.id, id));

    if (!memory) return c.json({ error: "Memory not found" }, 404);

    let relatedUsers: { id: string; slackUserId: string; displayName: string }[] = [];
    if (memory.relatedUserIds.length > 0) {
      relatedUsers = await db
        .select({
          id: userProfiles.id,
          slackUserId: userProfiles.slackUserId,
          displayName: userProfiles.displayName,
        })
        .from(userProfiles)
        .where(
          sql`${userProfiles.slackUserId} = ANY(${memory.relatedUserIds})`,
        );
    }

    return c.json({ ...memory, relatedUsers } as any, 200);
  } catch (error) {
    logger.error("Failed to get memory", { error });
    return c.json({ error: "Failed to get memory" }, 500);
  }
});

const updateMemoryRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Memories"],
  summary: "Update a memory",
  request: {
    params: idParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            content: z.string().optional(),
            relevanceScore: z.number().optional(),
            shareable: z.number().optional(),
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

dashboardMemoriesApp.openapi(updateMemoryRoute, async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<{
      content?: string;
      relevanceScore?: number;
      shareable?: number;
    }>();

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.content !== undefined) updates.content = body.content;
    if (body.relevanceScore !== undefined) updates.relevanceScore = body.relevanceScore;
    if (body.shareable !== undefined) updates.shareable = body.shareable;

    const [updated] = await db
      .update(memories)
      .set(updates)
      .where(eq(memories.id, id))
      .returning(memoryColumns);

    if (!updated) return c.json({ error: "Memory not found" }, 404);
    return c.json(updated as any, 200);
  } catch (error) {
    logger.error("Failed to update memory", { error });
    return c.json({ error: "Failed to update memory" }, 500);
  }
});

const deleteMemoryRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Memories"],
  summary: "Delete a memory",
  request: {
    params: idParamSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean() }),
        },
      },
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

dashboardMemoriesApp.openapi(deleteMemoryRoute, async (c) => {
  try {
    const id = c.req.param("id");
    const [deleted] = await db
      .delete(memories)
      .where(eq(memories.id, id))
      .returning({ id: memories.id });

    if (!deleted) return c.json({ error: "Memory not found" }, 404);
    return c.json({ ok: true } as any, 200);
  } catch (error) {
    logger.error("Failed to delete memory", { error });
    return c.json({ error: "Failed to delete memory" }, 500);
  }
});

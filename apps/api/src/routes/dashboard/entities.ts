import { createRoute, z } from "@hono/zod-openapi";
import { eq, desc, count, sql, ilike, and, type SQL } from "drizzle-orm";
import { entities, entityAliases, memoryEntities, memories } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, paginationQuerySchema, createDashboardApp } from "./schemas.js";

export const dashboardEntitiesApp = createDashboardApp();

const listEntitiesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Entities"],
  summary: "List entities",
  request: {
    query: paginationQuerySchema.extend({
      type: z.string().optional(),
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

dashboardEntitiesApp.openapi(listEntitiesRoute, async (c) => {
  try {
    const search = c.req.query("search");
    const type = c.req.query("type");
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100));
    const offset = (page - 1) * limit;

    const conditions: SQL[] = [];
    if (search) {
      const escaped = search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      conditions.push(ilike(entities.canonicalName, `%${escaped}%`));
    }
    if (type) {
      conditions.push(eq(entities.type, type));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [items, [totalRow]] = await Promise.all([
      db
        .select({
          id: entities.id,
          type: entities.type,
          canonicalName: entities.canonicalName,
          description: entities.description,
          slackUserId: entities.slackUserId,
          metadata: entities.metadata,
          createdAt: entities.createdAt,
          updatedAt: entities.updatedAt,
          memoryCount: sql<number>`(
            SELECT count(*)::int FROM memory_entities
            WHERE memory_entities.entity_id = ${entities.id}
          )`,
          aliasCount: sql<number>`(
            SELECT count(*)::int FROM entity_aliases
            WHERE entity_aliases.entity_id = ${entities.id}
          )`,
        })
        .from(entities)
        .where(where)
        .orderBy(desc(entities.updatedAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(entities).where(where),
    ]);

    return c.json({ items, total: totalRow.value } as any, 200);
  } catch (error) {
    logger.error("Failed to list entities", { error: String(error) });
    return c.json({ error: "Failed to list entities" }, 500);
  }
});

const getEntityRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Entities"],
  summary: "Get entity by ID with aliases and linked memories",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" } }),
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

dashboardEntitiesApp.openapi(getEntityRoute, async (c) => {
  try {
    const id = c.req.param("id");
    const [entity] = await db
      .select()
      .from(entities)
      .where(eq(entities.id, id));

    if (!entity) return c.json({ error: "Entity not found" }, 404);

    const aliases = await db
      .select({ id: entityAliases.id, alias: entityAliases.alias, source: entityAliases.source })
      .from(entityAliases)
      .where(eq(entityAliases.entityId, id));

    const linkedMemories = await db
      .select({
        memoryId: memoryEntities.memoryId,
        role: memoryEntities.role,
        content: memories.content,
        type: memories.type,
        relevanceScore: memories.relevanceScore,
        createdAt: memories.createdAt,
      })
      .from(memoryEntities)
      .innerJoin(memories, eq(memories.id, memoryEntities.memoryId))
      .where(eq(memoryEntities.entityId, id))
      .orderBy(desc(memories.createdAt));

    return c.json({ ...entity, aliases, linkedMemories } as any, 200);
  } catch (error) {
    logger.error("Failed to get entity", { error: String(error) });
    return c.json({ error: "Failed to get entity" }, 500);
  }
});

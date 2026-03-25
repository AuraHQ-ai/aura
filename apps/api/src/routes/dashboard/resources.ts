import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and, ilike, sql, desc } from "drizzle-orm";
import { resources } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, idParamSchema } from "./schemas.js";

export const dashboardResourcesApp = new OpenAPIHono();

const listResourcesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Resources"],
  summary: "List resources",
  request: {
    query: z.object({
      source: z.string().optional(),
      status: z.string().optional(),
      search: z.string().optional(),
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

dashboardResourcesApp.openapi(listResourcesRoute, async (c) => {
  try {
    const source = c.req.query("source");
    const status = c.req.query("status");
    const search = c.req.query("search");
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20));
    const offset = (page - 1) * limit;

    const conditions = [];
    if (source) conditions.push(eq(resources.source, source));
    if (status) conditions.push(eq(resources.status, status as "pending" | "ready" | "error"));
    if (search) conditions.push(ilike(resources.title, `%${search}%`));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [items, [{ total }]] = await Promise.all([
      db
        .select({
          id: resources.id,
          url: resources.url,
          parentUrl: resources.parentUrl,
          title: resources.title,
          source: resources.source,
          status: resources.status,
          summary: resources.summary,
          crawledAt: resources.crawledAt,
          createdAt: resources.createdAt,
          updatedAt: resources.updatedAt,
        })
        .from(resources)
        .where(where)
        .orderBy(desc(resources.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(resources)
        .where(where),
    ]);

    return c.json({ items, total } as any, 200);
  } catch (error) {
    logger.error("Failed to list resources", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const getResourceRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Resources"],
  summary: "Get resource by ID",
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

dashboardResourcesApp.openapi(getResourceRoute, async (c) => {
  try {
    const id = c.req.param("id");

    const [resource] = await db
      .select()
      .from(resources)
      .where(eq(resources.id, id))
      .limit(1);

    if (!resource) return c.json({ error: "Not found" }, 404);

    return c.json(resource as any, 200);
  } catch (error) {
    logger.error("Failed to get resource", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const deleteResourceRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Resources"],
  summary: "Delete a resource",
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

dashboardResourcesApp.openapi(deleteResourceRoute, async (c) => {
  try {
    const id = c.req.param("id");

    const [deleted] = await db
      .delete(resources)
      .where(eq(resources.id, id))
      .returning({ id: resources.id });

    if (!deleted) return c.json({ error: "Not found" }, 404);

    return c.json({ ok: true } as any, 200);
  } catch (error) {
    logger.error("Failed to delete resource", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

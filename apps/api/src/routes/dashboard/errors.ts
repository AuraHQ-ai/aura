import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql, ilike, desc, and, inArray } from "drizzle-orm";
import { errorEvents } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, idParamSchema } from "./schemas.js";

export const dashboardErrorsApp = new OpenAPIHono();

const listErrorsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Errors"],
  summary: "List error events",
  request: {
    query: z.object({
      search: z.string().optional(),
      resolved: z.string().optional(),
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

dashboardErrorsApp.openapi(listErrorsRoute, async (c) => {
  try {
    const search = c.req.query("search") ?? "";
    const resolved = c.req.query("resolved");
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10)));
    const offset = (page - 1) * limit;

    const conditions = [];
    if (search) {
      conditions.push(ilike(errorEvents.errorName, `%${search}%`));
    }
    if (resolved === "true") {
      conditions.push(eq(errorEvents.resolved, true));
    } else if (resolved === "false") {
      conditions.push(eq(errorEvents.resolved, false));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [items, countResult] = await Promise.all([
      db
        .select()
        .from(errorEvents)
        .where(where)
        .orderBy(desc(errorEvents.timestamp))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(errorEvents)
        .where(where),
    ]);

    return c.json({ items, total: countResult[0]?.count ?? 0 } as any, 200);
  } catch (error) {
    logger.error("Failed to list errors", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const getErrorRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Errors"],
  summary: "Get error event by ID",
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

dashboardErrorsApp.openapi(getErrorRoute, async (c) => {
  try {
    const id = c.req.param("id");

    const rows = await db
      .select()
      .from(errorEvents)
      .where(eq(errorEvents.id, id))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "Error not found" }, 404);
    }

    return c.json(rows[0] as any, 200);
  } catch (error) {
    logger.error("Failed to get error", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const bulkResolveErrorsRoute = createRoute({
  method: "patch",
  path: "/",
  tags: ["Errors"],
  summary: "Bulk resolve errors",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            ids: z.array(z.string()),
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
          schema: z.object({ resolved: z.number() }),
        },
      },
      description: "Success",
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

dashboardErrorsApp.openapi(bulkResolveErrorsRoute, async (c) => {
  try {
    const body = await c.req.json<{ ids: string[] }>();

    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return c.json({ error: "'ids' array is required" }, 400);
    }

    const updated = await db
      .update(errorEvents)
      .set({ resolved: true })
      .where(inArray(errorEvents.id, body.ids))
      .returning({ id: errorEvents.id });

    return c.json({ resolved: updated.length } as any, 200);
  } catch (error) {
    logger.error("Failed to bulk resolve errors", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

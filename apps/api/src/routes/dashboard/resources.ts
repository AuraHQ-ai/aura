import { Hono } from "hono";
import { eq, and, ilike, sql, desc } from "drizzle-orm";
import { resources } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";

export const dashboardResourcesApp = new Hono();

dashboardResourcesApp.get("/", async (c) => {
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

    return c.json({ items, total });
  } catch (error) {
    logger.error("Failed to list resources", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

dashboardResourcesApp.get("/:id", async (c) => {
  try {
    const id = c.req.param("id");

    const [resource] = await db
      .select()
      .from(resources)
      .where(eq(resources.id, id))
      .limit(1);

    if (!resource) return c.json({ error: "Not found" }, 404);

    return c.json(resource);
  } catch (error) {
    logger.error("Failed to get resource", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

dashboardResourcesApp.delete("/:id", async (c) => {
  try {
    const id = c.req.param("id");

    const [deleted] = await db
      .delete(resources)
      .where(eq(resources.id, id))
      .returning({ id: resources.id });

    if (!deleted) return c.json({ error: "Not found" }, 404);

    return c.json({ ok: true });
  } catch (error) {
    logger.error("Failed to delete resource", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

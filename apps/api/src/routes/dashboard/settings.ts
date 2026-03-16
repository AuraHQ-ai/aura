import { Hono } from "hono";
import { eq, asc, sql } from "drizzle-orm";
import { settings } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";

export const dashboardSettingsApp = new Hono();

dashboardSettingsApp.get("/", async (c) => {
  try {
    const allSettings = await db
      .select()
      .from(settings)
      .orderBy(asc(settings.key));

    return c.json(allSettings);
  } catch (error) {
    logger.error("Failed to list settings", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

dashboardSettingsApp.get("/:key", async (c) => {
  try {
    const key = c.req.param("key");

    const [setting] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);

    if (!setting) return c.json({ error: "Not found" }, 404);

    return c.json({ value: setting.value });
  } catch (error) {
    logger.error("Failed to get setting", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

dashboardSettingsApp.put("/:key", async (c) => {
  try {
    const key = c.req.param("key");
    const { value } = await c.req.json<{ value: string }>();

    const [upserted] = await db
      .insert(settings)
      .values({
        key,
        value,
        updatedAt: new Date(),
        updatedBy: "dashboard",
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value,
          updatedAt: new Date(),
          updatedBy: "dashboard",
        },
      })
      .returning();

    return c.json(upserted);
  } catch (error) {
    logger.error("Failed to upsert setting", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

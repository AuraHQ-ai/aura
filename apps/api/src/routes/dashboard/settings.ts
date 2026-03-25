import { createRoute, z } from "@hono/zod-openapi";
import { eq, asc, sql } from "drizzle-orm";
import { settings } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, createDashboardApp } from "./schemas.js";

export const dashboardSettingsApp = createDashboardApp();

const listSettingsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Settings"],
  summary: "List all settings",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.array(z.any()),
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

dashboardSettingsApp.openapi(listSettingsRoute, async (c) => {
  try {
    const allSettings = await db
      .select()
      .from(settings)
      .orderBy(asc(settings.key));

    return c.json(allSettings as any, 200);
  } catch (error) {
    logger.error("Failed to list settings", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const getSettingRoute = createRoute({
  method: "get",
  path: "/{key}",
  tags: ["Settings"],
  summary: "Get a setting by key",
  request: {
    params: z.object({
      key: z.string().openapi({ param: { name: "key", in: "path" } }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ value: z.string() }),
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

dashboardSettingsApp.openapi(getSettingRoute, async (c) => {
  try {
    const key = c.req.param("key");

    const [setting] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);

    if (!setting) return c.json({ error: "Not found" }, 404);

    return c.json({ value: setting.value } as any, 200);
  } catch (error) {
    logger.error("Failed to get setting", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const upsertSettingRoute = createRoute({
  method: "put",
  path: "/{key}",
  tags: ["Settings"],
  summary: "Create or update a setting",
  request: {
    params: z.object({
      key: z.string().openapi({ param: { name: "key", in: "path" } }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ value: z.string() }),
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
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardSettingsApp.openapi(upsertSettingRoute, async (c) => {
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
        target: [settings.workspaceId, settings.key],
        set: {
          value,
          updatedAt: new Date(),
          updatedBy: "dashboard",
        },
      })
      .returning();

    return c.json(upserted as any, 200);
  } catch (error) {
    logger.error("Failed to upsert setting", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

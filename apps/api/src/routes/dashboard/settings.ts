import { createRoute, z } from "@hono/zod-openapi";
import { eq, asc } from "drizzle-orm";
import { settings } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { errorSchema, createDashboardApp } from "./schemas.js";
import { isSecretSettingKey, redactSettingValue, MASKED_VALUE } from "../../lib/settings-redaction.js";

export const dashboardSettingsApp = createDashboardApp();

const redactedSettingSchema = z.object({
  key: z.string(),
  value: z.string(),
  hasValue: z.boolean(),
  redacted: z.boolean(),
  description: z.string().nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
  workspaceId: z.string(),
});

const listSettingsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Settings"],
  summary: "List all settings",
  description:
    "Returns all settings for the workspace. Values for secret-bearing keys (tokens, passwords, API keys, etc.) are replaced with a masked placeholder; those rows include `redacted: true` and `hasValue: true` when a value is stored.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.array(redactedSettingSchema),
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

    return c.json(allSettings.map(redactSettingValue) as any, 200);
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
  description:
    "Returns a single setting. For secret-bearing keys the value is replaced with a masked placeholder and `redacted: true` is set. Use PUT to overwrite; submit an empty value to leave the stored value unchanged.",
  request: {
    params: z.object({
      key: z.string().openapi({ param: { name: "key", in: "path" } }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            value: z.string(),
            hasValue: z.boolean(),
            redacted: z.boolean(),
          }),
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

    const redacted = redactSettingValue(setting);
    return c.json(
      { value: redacted.value, hasValue: redacted.hasValue, redacted: redacted.redacted } as any,
      200,
    );
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
  description:
    "Upserts a setting value. For secret-bearing keys, submitting an empty string leaves the stored value unchanged (write-only semantics). Submitting the masked placeholder value is also treated as no-op. Non-empty values always overwrite.",
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
    204: {
      description: "No-op: secret key with empty value submitted, stored value unchanged",
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

    // Write-only semantics for secret keys: empty string or the masked
    // placeholder both mean "leave stored value unchanged".
    if (isSecretSettingKey(key) && (value === "" || value === MASKED_VALUE)) {
      return c.body(null, 204);
    }

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

    return c.json(redactSettingValue(upserted) as any, 200);
  } catch (error) {
    logger.error("Failed to upsert setting", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

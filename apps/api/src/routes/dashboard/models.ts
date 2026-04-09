import { createRoute, z } from "@hono/zod-openapi";
import { hasRole } from "../../lib/permissions.js";
import {
  getModelCatalogResponse,
  syncModelCatalogFromGateway,
} from "../../lib/model-catalog.js";
import { createDashboardApp } from "./schemas.js";

export const dashboardModelsApp = createDashboardApp();

const listModelsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Models"],
  summary: "List available models",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            main: z.array(z.any()),
            fast: z.array(z.any()),
            embedding: z.array(z.any()),
            escalation: z.array(z.any()),
            defaults: z.record(z.string(), z.string()),
            catalog: z.array(z.any()),
            lastSyncedAt: z.string().nullable(),
          }),
        },
      },
      description: "Success",
    },
  },
});

dashboardModelsApp.openapi(listModelsRoute, async (c) => {
  const catalog = await getModelCatalogResponse();
  return c.json(catalog as any, 200);
});

const refreshModelsRoute = createRoute({
  method: "post",
  path: "/refresh",
  tags: ["Models"],
  summary: "Refresh available models from Vercel AI Gateway",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            modelCount: z.number(),
            refreshedAt: z.string(),
          }),
        },
      },
      description: "Success",
    },
    403: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Forbidden",
    },
  },
});

dashboardModelsApp.openapi(refreshModelsRoute, async (c) => {
  const userId = c.get("userId" as never) as string | undefined;
  if (userId) {
    const admin = await hasRole(userId, "admin");
    if (!admin) {
      return c.json({ error: "Forbidden" }, 403);
    }
  }

  const result = await syncModelCatalogFromGateway();
  return c.json(
    {
      ok: true,
      modelCount: result.modelCount,
      refreshedAt: result.syncedAt.toISOString(),
    } as any,
    200,
  );
});

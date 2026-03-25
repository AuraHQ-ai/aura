import { createRoute, z } from "@hono/zod-openapi";
import { MAIN_MODELS, FAST_MODELS, EMBEDDING_MODELS, MODEL_DEFAULTS } from "../../lib/models.js";
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
            defaults: z.record(z.string(), z.string()),
          }),
        },
      },
      description: "Success",
    },
  },
});

dashboardModelsApp.openapi(listModelsRoute, (c) => {
  return c.json(
    {
      main: MAIN_MODELS,
      fast: FAST_MODELS,
      embedding: EMBEDDING_MODELS,
      defaults: MODEL_DEFAULTS,
    } as any,
    200,
  );
});

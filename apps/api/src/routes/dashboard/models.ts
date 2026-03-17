import { Hono } from "hono";
import { MAIN_MODELS, FAST_MODELS, EMBEDDING_MODELS, MODEL_DEFAULTS } from "../../lib/models.js";

export const dashboardModelsApp = new Hono();

dashboardModelsApp.get("/", (c) => {
  return c.json({
    main: MAIN_MODELS,
    fast: FAST_MODELS,
    embedding: EMBEDDING_MODELS,
    defaults: MODEL_DEFAULTS,
  });
});

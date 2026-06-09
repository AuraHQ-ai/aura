import { Hono } from "hono";
import { logger } from "../lib/logger.js";
import { scoreUnscoredResponses } from "../eval/response-scorer.js";

const DEFAULT_CRON_LIMIT = 75;

export const scoreResponsesApp = new Hono();

scoreResponsesApp.get("/api/cron/score-responses", async (c) => {
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("Unauthorized eval response scoring cron invocation attempt");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const limitParam = c.req.query("limit");
  const limit = limitParam ? Number(limitParam) : DEFAULT_CRON_LIMIT;

  try {
    const result = await scoreUnscoredResponses({ limit });
    logger.info("Eval response scoring cron completed", result);
    return c.json({ ok: true, ...result });
  } catch (error) {
    logger.error("Eval response scoring cron failed", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

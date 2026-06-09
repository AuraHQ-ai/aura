import { Hono } from "hono";
import { logger } from "../lib/logger.js";
import { scoreUnscoredResponses } from "../eval/score.js";

/**
 * Vercel Cron handler for the eval funnel (Machine A).
 *
 * Scores every unscored assistant response once, walking forward from the
 * corpus start. Idempotent and resumable — bounded per invocation by a window
 * + wall-clock budget so it fits one serverless execution; the next overnight
 * run continues where this one left off. Never re-scores on read.
 *
 * Protected by CRON_SECRET. Also accepts ?maxWindows=&maxThreads= overrides for
 * manual backfill kicks.
 */
export const evalFunnelApp = new Hono();

evalFunnelApp.get("/api/cron/eval-funnel", async (c) => {
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("Unauthorized eval-funnel cron invocation");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const maxWindows = c.req.query("maxWindows")
    ? parseInt(c.req.query("maxWindows")!, 10)
    : undefined;
  const maxThreads = c.req.query("maxThreads")
    ? parseInt(c.req.query("maxThreads")!, 10)
    : undefined;

  logger.info("Cron: eval funnel starting", { maxWindows, maxThreads });
  const start = Date.now();

  try {
    const result = await scoreUnscoredResponses({ maxWindows, maxThreads });
    const duration = Date.now() - start;
    logger.info(`Cron: eval funnel completed in ${duration}ms`, { ...result });
    return c.json({ ok: true, duration, ...result });
  } catch (error) {
    logger.error("Cron: eval funnel failed", { error: String(error) });
    return c.json({ error: "Eval funnel failed" }, 500);
  }
});

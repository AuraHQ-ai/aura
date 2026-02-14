import { Hono } from "hono";
import { runConsolidation } from "../memory/consolidate.js";
import { logger } from "../lib/logger.js";

export const cronApp = new Hono();

/**
 * Vercel Cron handler for memory consolidation.
 * Runs daily at 4:00 AM UTC (configured in vercel.json).
 *
 * Protected by CRON_SECRET to prevent unauthorized invocation.
 */
cronApp.get("/api/cron/consolidate", async (c) => {
  // Verify cron secret
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("Unauthorized cron invocation attempt");
    return c.json({ error: "Unauthorized" }, 401);
  }

  logger.info("Cron: Starting memory consolidation");
  const start = Date.now();

  try {
    const result = await runConsolidation();

    const duration = Date.now() - start;
    logger.info(`Cron: Consolidation completed in ${duration}ms`, result);

    return c.json({
      ok: true,
      duration,
      ...result,
    });
  } catch (error) {
    logger.error("Cron: Consolidation failed", { error: String(error) });
    return c.json({ error: "Consolidation failed" }, 500);
  }
});

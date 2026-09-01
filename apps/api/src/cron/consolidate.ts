import { Hono } from "hono";
import { runConsolidation } from "../memory/consolidate.js";
import { regenerateStaleSummaries } from "../memory/entity-summaries.js";
import { logger } from "../lib/logger.js";

export const cronApp = new Hono();

/**
 * Vercel Cron handler for memory and profile consolidation.
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

  logger.info("Cron: Starting consolidation");
  const start = Date.now();

  try {
    const result = await runConsolidation();

    // NOTE (#911): profile consolidation (users.known_facts compaction) was
    // retired — entity summaries below are the profile source of truth.

    let entitySummaryResult = null;
    try {
      entitySummaryResult = await regenerateStaleSummaries();
    } catch (error) {
      logger.error("Cron: Entity summary regeneration failed (non-fatal)", {
        error: String(error),
      });
    }

    const duration = Date.now() - start;
    logger.info(`Cron: Consolidation completed in ${duration}ms`, {
      ...result,
      entitySummaryResult,
    });

    return c.json({
      ok: true,
      duration,
      ...result,
      entitySummaries: entitySummaryResult,
    });
  } catch (error) {
    logger.error("Cron: Consolidation failed", { error: String(error) });
    return c.json({ error: "Consolidation failed" }, 500);
  }
});

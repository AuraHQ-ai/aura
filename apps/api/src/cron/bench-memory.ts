import { Hono } from "hono";
import { runMemoryBench } from "../bench/runner.js";
import { logger } from "../lib/logger.js";

export const benchMemoryCronApp = new Hono();

/**
 * Optional manual memory benchmark (NOT scheduled — invoke with CRON_SECRET).
 * Prefer GitHub Actions on memory path changes or `pnpm bench:memory` locally.
 */
benchMemoryCronApp.get("/api/cron/bench-memory", async (c) => {
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("Unauthorized bench-memory cron attempt");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const start = Date.now();
  logger.info("Cron: Starting memory benchmark");

  try {
    const result = await runMemoryBench({
      dataset: "lme",
      subset: "full",
      skipIngest: false,
      dryRun: false,
      judge: true,
      postSlack: process.env.MEMORY_BENCH_SLACK_CHANNEL != null,
      concurrency: 4,
    });

    return c.json({
      ok: result.ok,
      duration: Date.now() - start,
      runId: result.runId,
      scores: result.scores,
    });
  } catch (error) {
    logger.error("Cron: Memory benchmark failed", { error: String(error) });
    return c.json({ ok: false, error: String(error) }, 500);
  }
});

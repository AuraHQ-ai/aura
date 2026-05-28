import { Hono } from "hono";
import { logger } from "../lib/logger.js";
import { runMemoryBench } from "../../bench/src/runner.js";

export const benchMemoryApp = new Hono();

benchMemoryApp.get("/api/cron/bench-memory", async (c) => {
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("Unauthorized memory benchmark cron invocation");
    return c.json({ error: "Unauthorized" }, 401);
  }

  logger.info("Cron: Starting memory benchmark");
  const result = await runMemoryBench({
    dataset: "lme",
    subset: "full",
    skipIngest: false,
    dryRun: false,
    json: true,
    postSlack: true,
    judge: process.env.MEMORY_BENCH_JUDGE_MODEL || "configured-fast-model",
  });

  if (!result.ok) {
    logger.error("Cron: Memory benchmark failed", { error: result.error });
    return c.json(result, 500);
  }

  logger.info("Cron: Memory benchmark completed", {
    runId: result.runId,
    durationMs: result.durationMs,
    aggregates: result.aggregates.length,
  });

  return c.json(result);
});

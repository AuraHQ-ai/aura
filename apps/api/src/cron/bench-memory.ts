import { Hono } from "hono";
import { logger } from "../lib/logger.js";

export const benchMemoryCronApp = new Hono();

/**
 * Nightly memory benchmark.
 *
 * Schedule: 30 minutes after `/api/cron/consolidate` so the consolidation
 * job's churn doesn't bleed into bench timings.
 *
 * Posts a Block Kit summary to `MEMORY_BENCH_SLACK_CHANNEL` when set. If
 * that env var is missing the run still completes and writes scores to
 * `bench_runs`; only the Slack post is suppressed.
 *
 * Protected by `CRON_SECRET` — matches the pattern in cron/consolidate.ts.
 */
benchMemoryCronApp.get("/api/cron/bench-memory", async (c) => {
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("Unauthorized bench-memory cron invocation");
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Dynamic import — keeps cold start small for non-bench requests and
  // honours the rule about not eager-loading optional integrations.
  const { runBench } = await import("../../bench/src/runner.js");

  logger.info("Cron: starting nightly memory bench");
  const start = Date.now();

  try {
    // Nightly defaults: full vendored subset across whichever datasets are
    // present on disk. Skips datasets whose corpus files are missing
    // (LoCoMo today, pending license decision).
    const output = await runBench({
      datasets: ["longmemeval", "locomo"],
      subset: "full",
      postSlack: true,
    });

    const duration = Date.now() - start;
    logger.info(`Cron: bench complete in ${duration}ms`, {
      runId: output.runId,
      cases: output.results.length,
      scoreRows: output.scores.length,
      slackTs: output.slackTs ?? null,
    });

    return c.json({
      ok: true,
      duration,
      runId: output.runId,
      scores: output.scores.length,
      cases: output.results.length,
      slackTs: output.slackTs ?? null,
    });
  } catch (error) {
    logger.error("Cron: memory bench failed", {
      error: String(error).slice(0, 500),
    });
    return c.json({ error: "Bench run failed" }, 500);
  }
});

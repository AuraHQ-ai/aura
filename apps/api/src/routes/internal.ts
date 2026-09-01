import { Hono } from "hono";
import { logger } from "../lib/logger.js";

/**
 * Internal operational endpoints. Guarded by the same Bearer CRON_SECRET
 * mechanism as the cron routes — these are for deploy tooling and operators,
 * never end users.
 */
export const internalApp = new Hono();

internalApp.use("/api/internal/*", async (c, next) => {
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("Unauthorized internal endpoint invocation attempt", {
      path: c.req.path,
    });
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
});

/**
 * Post-deploy smoke check (#986): one cheap authenticated liveness call per
 * external integration. Returns 200 when nothing failed, 503 when at least
 * one integration failed (skipped integrations don't fail the check).
 */
internalApp.get("/api/internal/smoke", async (c) => {
  const { runSmokeChecks } = await import("../lib/smoke-check.js");
  const report = await runSmokeChecks();
  return c.json(report, report.ok ? 200 : 503);
});

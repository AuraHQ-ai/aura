import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { jobs } from "@aura/db/schema";
import { logger } from "../lib/logger.js";

/**
 * Enabled recurring jobs must always live in status='pending' between runs;
 * the heartbeat only selects pending jobs. Anything that leaves one in a
 * terminal state ('completed' / 'failed') silently stops it forever (see the
 * Sep 24 2026 digest stall, #1526). Reset them at the top of every sweep.
 */
export async function selfHealTerminalRecurringJobs(): Promise<number> {
  const healed = await db
    .update(jobs)
    .set({ status: "pending", executeAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(jobs.enabled, 1),
        inArray(jobs.status, ["completed", "failed"]),
        sql`(${jobs.cronSchedule} IS NOT NULL AND ${jobs.cronSchedule} != '' OR ${jobs.frequencyConfig} IS NOT NULL)`,
      ),
    )
    .returning({ id: jobs.id, name: jobs.name });

  for (const job of healed) {
    logger.warn("recurring_job_self_healed_terminal_status", {
      jobId: job.id,
      jobName: job.name,
    });
  }
  return healed.length;
}

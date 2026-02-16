import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { generateText, stepCountIs } from "ai";
import { eq, and, lt, lte, sql, isNull, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { jobs, notes, scheduledActions } from "../db/schema.js";
import type { FrequencyConfig } from "../db/schema.js";
import { getMainModel } from "../lib/ai.js";
import { createSlackTools } from "../tools/slack.js";
import { buildSkillIndex } from "../lib/skill-index.js";
import { logger } from "../lib/logger.js";

const botToken = process.env.SLACK_BOT_TOKEN || "";
const slackClient = new WebClient(botToken);

/** Max jobs to execute per heartbeat invocation (stay within 800s timeout) */
const MAX_JOBS_PER_HEARTBEAT = 3;

// ── Heartbeat System Prompt ──────────────────────────────────────────────────

const HEARTBEAT_SYSTEM_PROMPT = `You are Aura executing a job during your heartbeat cycle. You have full tool access.

Rules:
- Execute the job described in the playbook below.
- Your available skill notes are listed above. Use read_note to load a full skill when relevant.
- Be concise. Post results, not essays.
- If you discover something urgent, DM the relevant person or schedule a follow-up.
- If the job can't be completed in this cycle, use checkpoint_plan to save progress.
- Save any reusable insights as skill notes for future runs.`;

// ── Job Eligibility ──────────────────────────────────────────────────────────

/**
 * Check if a job is due for execution based on its frequency config.
 */
function isJobDue(job: typeof jobs.$inferSelect): boolean {
  const config = job.frequencyConfig as FrequencyConfig | null;
  if (!config) return true;

  const now = new Date();

  // Min interval check
  if (config.minIntervalHours && job.lastExecutedAt) {
    const minIntervalMs = config.minIntervalHours * 60 * 60 * 1000;
    const nextAllowed = new Date(
      job.lastExecutedAt.getTime() + minIntervalMs,
    );
    if (now < nextAllowed) return false;
  }

  // Max per day check
  if (config.maxPerDay) {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    // Approximate: if executionCount / days_since_creation > maxPerDay, skip
    // More precise: would need an execution log table, but this is good enough
    // for now we just check if last execution was today and count
    if (job.lastExecutedAt && job.lastExecutedAt >= startOfDay) {
      // Already ran today — check if we've hit the limit
      // Simple heuristic: if lastExecutedAt is today, assume 1 execution today
      // For maxPerDay > 1, the minIntervalHours should handle spacing
      if (config.maxPerDay <= 1) return false;
    }
  }

  // Cooldown check
  if (config.cooldownHours && job.lastExecutedAt) {
    const cooldownMs = config.cooldownHours * 60 * 60 * 1000;
    const cooldownUntil = new Date(
      job.lastExecutedAt.getTime() + cooldownMs,
    );
    if (now < cooldownUntil) return false;
  }

  return true;
}

// ── Heartbeat Cron App ───────────────────────────────────────────────────────

export const heartbeatApp = new Hono();

heartbeatApp.get("/api/cron/heartbeat", async (c) => {
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("Unauthorized heartbeat cron invocation");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const heartbeatStart = Date.now();
  logger.info("Heartbeat starting");

  let jobsExecuted = 0;
  let jobsFailed = 0;
  let plansExpired = 0;
  let plansAbandoned = 0;

  try {
    // ── 1. Evaluate and execute due jobs ─────────────────────────────────

    const enabledJobs = await db
      .select()
      .from(jobs)
      .where(eq(jobs.enabled, 1))
      .orderBy(sql`${jobs.lastExecutedAt} ASC NULLS FIRST`);

    const dueJobs = enabledJobs.filter(isJobDue).slice(0, MAX_JOBS_PER_HEARTBEAT);

    if (dueJobs.length > 0) {
      logger.info(`Heartbeat: ${dueJobs.length} jobs due (of ${enabledJobs.length} enabled)`);

      const skillIndex = await buildSkillIndex();

      for (const job of dueJobs) {
        try {
          await executeJob(job, skillIndex);
          jobsExecuted++;
        } catch (error: any) {
          logger.error("Heartbeat: job execution failed", {
            jobName: job.name,
            error: error.message,
          });
          jobsFailed++;
        }
      }
    } else {
      logger.info(`Heartbeat: no jobs due (${enabledJobs.length} enabled)`);
    }

    // ── 2. Expire stale plan notes ───────────────────────────────────────

    const now = new Date();
    const expireResult = await db
      .delete(notes)
      .where(
        and(
          eq(notes.category, "plan"),
          lte(notes.expiresAt, now),
        ),
      )
      .returning({ topic: notes.topic });

    plansExpired = expireResult.length;
    if (plansExpired > 0) {
      logger.info(`Heartbeat: expired ${plansExpired} plan notes`, {
        topics: expireResult.map((r) => r.topic),
      });
    }

    // ── 3. Flag abandoned plans ──────────────────────────────────────────

    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const stalePlans = await db
      .select({ topic: notes.topic, updatedAt: notes.updatedAt })
      .from(notes)
      .where(
        and(
          eq(notes.category, "plan"),
          lt(notes.updatedAt, twoDaysAgo),
          or(isNull(notes.expiresAt), sql`${notes.expiresAt} > NOW()`),
        ),
      );

    plansAbandoned = stalePlans.length;
    if (plansAbandoned > 0) {
      logger.warn(`Heartbeat: ${plansAbandoned} potentially abandoned plans`, {
        topics: stalePlans.map((p) => p.topic),
      });
    }

    // ── Done ─────────────────────────────────────────────────────────────

    const duration = Date.now() - heartbeatStart;
    logger.info(`Heartbeat completed in ${duration}ms`, {
      jobsExecuted,
      jobsFailed,
      plansExpired,
      plansAbandoned,
    });

    return c.json({
      ok: true,
      jobsExecuted,
      jobsFailed,
      plansExpired,
      plansAbandoned,
      duration,
    });
  } catch (error: any) {
    logger.error("Heartbeat failed", { error: error.message });
    return c.json({ error: "Heartbeat failed" }, 500);
  }
});

// ── Job Execution ────────────────────────────────────────────────────────────

async function executeJob(
  job: typeof jobs.$inferSelect,
  skillIndex: string,
) {
  const prompt = job.playbook
    ? `Job: ${job.name}\nDescription: ${job.description}\n\nPlaybook:\n${job.playbook}`
    : `Job: ${job.name}\nDescription: ${job.description}`;

  const systemPrompt = HEARTBEAT_SYSTEM_PROMPT + skillIndex;

  const model = await getMainModel();

  logger.info("Heartbeat: executing job", {
    jobName: job.name,
    hasPlaybook: !!job.playbook,
    hasChannel: !!job.channelId,
  });

  const { text } = await generateText({
    model,
    system: systemPrompt,
    prompt,
    tools: createSlackTools(slackClient, {
      userId: "aura",
      channelId: job.channelId || "",
    }),
    stopWhen: stepCountIs(15),
  });

  const result = (text || "Job completed (no text output)").substring(0, 2000);

  await db
    .update(jobs)
    .set({
      lastExecutedAt: new Date(),
      executionCount: sql`${jobs.executionCount} + 1`,
      lastResult: result,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id));

  logger.info("Heartbeat: job completed", {
    jobName: job.name,
    resultLength: result.length,
  });
}

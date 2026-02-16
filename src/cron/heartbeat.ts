import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { generateText, stepCountIs } from "ai";
import { eq, and, lt, lte, sql, isNull, or } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { db } from "../db/client.js";
import { jobs, notes } from "../db/schema.js";
import type { FrequencyConfig } from "../db/schema.js";
import { getMainModel } from "../lib/ai.js";
import { createSlackTools } from "../tools/slack.js";
import { buildSkillIndex } from "../lib/skill-index.js";
import { logger } from "../lib/logger.js";

const botToken = process.env.SLACK_BOT_TOKEN || "";
const slackClient = new WebClient(botToken);

/** Max jobs to process per heartbeat sweep */
const MAX_JOBS_PER_SWEEP = 10;

/** Max retries before marking as failed */
const MAX_RETRIES = 3;

/** Retry delay in ms (10 minutes) */
const RETRY_DELAY_MS = 10 * 60 * 1000;

// ── System Prompts ───────────────────────────────────────────────────────────

const JOB_SYSTEM_PROMPT = `You are Aura executing a job autonomously. You have full access to your tools.

Rules:
- Execute the task described below. Use your tools to read channels, post messages, look up users, etc.
- Post results to the channel specified unless the task says otherwise.
- If you have "previous result" context, compare and highlight changes (e.g. "17 bugs yesterday, 22 today -- that's a spike").
- If you discover something urgent or unexpected, you can:
  - Create a follow-up job (create_job)
  - DM the person who requested this to escalate (send_direct_message)
  - Save findings to your notes for future reference (save_note / edit_note)
- If the task no longer makes sense (channel deleted, user gone, etc.), note that in your result.
- Be concise. Digests and summaries, not essays.
- Do NOT respond conversationally. Just execute the task and report.`;

const CONTINUATION_SYSTEM_PROMPT = `You are Aura resuming a multi-step task. Your accumulated progress and context are below.

Rules:
- Continue from where you left off. The plan note contains your progress, next steps, and context.
- If you can't finish in this round, use checkpoint_plan again to save progress and schedule another continuation.
- Post results in the thread you're continuing (routing is automatic).
- Be concise and focused. Don't re-explain what was already done — just continue the work.
- If the continuation depth limit is reached, explain your current status and ask if you should keep going.`;

// ── Continuation Detection ───────────────────────────────────────────────────

const CONTINUE_TAG_RE = /^\[CONTINUE:([^\]]+)\]\s*/;

function parseContinuationTag(description: string): string | null {
  const match = description.match(CONTINUE_TAG_RE);
  return match ? match[1] : null;
}

async function loadPlanNote(topic: string): Promise<string | null> {
  const rows = await db
    .select({ content: notes.content })
    .from(notes)
    .where(eq(notes.topic, topic))
    .limit(1);
  return rows[0]?.content ?? null;
}

// ── Job Eligibility (recurring jobs) ─────────────────────────────────────────

function isRecurringJobDue(job: typeof jobs.$inferSelect): boolean {
  const now = new Date();

  if (job.cronSchedule) {
    try {
      // Offset by 1 s so that prev() includes the current boundary tick.
      // Without this, prev() is exclusive of currentDate and misses the
      // exact scheduled second, causing jobs to skip their on-time tick.
      const cron = CronExpressionParser.parse(job.cronSchedule, {
        currentDate: new Date(now.getTime() + 1000),
        tz: job.timezone || undefined,
      });
      const lastCronTick = cron.prev().toDate();

      if (job.lastExecutedAt && job.lastExecutedAt >= lastCronTick) {
        return false;
      }
      if (!job.lastExecutedAt && job.createdAt >= lastCronTick) {
        return false;
      }
    } catch {
      logger.warn("isRecurringJobDue: invalid cron, skipping", {
        jobName: job.name,
        cronSchedule: job.cronSchedule,
      });
      return false;
    }
  }

  const config = job.frequencyConfig as FrequencyConfig | null;
  if (!config) return true;

  if (config.minIntervalHours && job.lastExecutedAt) {
    const minIntervalMs = config.minIntervalHours * 60 * 60 * 1000;
    if (now < new Date(job.lastExecutedAt.getTime() + minIntervalMs)) return false;
  }

  if (config.maxPerDay) {
    const todayStr = now.toISOString().slice(0, 10);
    const executionsToday =
      job.lastExecutionDate === todayStr ? job.todayExecutions : 0;
    if (executionsToday >= config.maxPerDay) return false;
  }

  if (config.cooldownHours && job.lastExecutedAt) {
    const cooldownMs = config.cooldownHours * 60 * 60 * 1000;
    if (now < new Date(job.lastExecutedAt.getTime() + cooldownMs)) return false;
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

  const sweepStart = Date.now();
  logger.info("Heartbeat starting");

  let executed = 0;
  let failed = 0;
  let plansExpired = 0;
  let plansAbandoned = 0;

  try {
    const now = new Date();

    // ── 1. Query all pending enabled jobs ────────────────────────────────

    const pendingJobs = await db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "pending"),
          eq(jobs.enabled, 1),
          or(
            // One-shot/continuation: due when executeAt <= now
            lte(jobs.executeAt, now),
            // Recurring: no executeAt, has cron or frequency (needs app-side eval)
            and(
              isNull(jobs.executeAt),
              sql`(${jobs.cronSchedule} IS NOT NULL AND ${jobs.cronSchedule} != '' OR ${jobs.frequencyConfig} IS NOT NULL)`,
            ),
          ),
        ),
      )
      .orderBy(
        sql`CASE WHEN ${jobs.priority} = 'high' THEN 0 WHEN ${jobs.priority} = 'normal' THEN 1 ELSE 2 END`,
        sql`${jobs.lastExecutedAt} ASC NULLS FIRST`,
        sql`${jobs.executeAt} ASC NULLS LAST`,
      );

    // ── 2. Filter to due jobs ────────────────────────────────────────────

    const dueJobs: (typeof jobs.$inferSelect)[] = [];

    for (const job of pendingJobs) {
      if (dueJobs.length >= MAX_JOBS_PER_SWEEP) break;

      if (job.executeAt) {
        // One-shot or continuation: already filtered by DB (executeAt <= now)
        dueJobs.push(job);
      } else if (job.cronSchedule || job.frequencyConfig) {
        // Recurring: evaluate cron + frequency guards
        if (isRecurringJobDue(job)) {
          dueJobs.push(job);
        }
      }
    }

    if (dueJobs.length > 0) {
      logger.info(`Heartbeat: ${dueJobs.length} jobs due (of ${pendingJobs.length} pending)`);

      const skillIndex = await buildSkillIndex();

      for (const job of dueJobs) {
        try {
          await executeJob(job, skillIndex);
          executed++;
        } catch (error: any) {
          logger.error("Heartbeat: job execution error", {
            jobName: job.name,
            error: error.message,
          });
          failed++;
        }
      }
    } else {
      logger.info(`Heartbeat: no jobs due (${pendingJobs.length} pending)`);
    }

    // ── 3. Expire stale plan notes ───────────────────────────────────────

    const expireResult = await db
      .delete(notes)
      .where(and(eq(notes.category, "plan"), lte(notes.expiresAt, now)))
      .returning({ topic: notes.topic });

    plansExpired = expireResult.length;
    if (plansExpired > 0) {
      logger.info(`Heartbeat: expired ${plansExpired} plan notes`, {
        topics: expireResult.map((r) => r.topic),
      });
    }

    // ── 4. Flag abandoned plans ──────────────────────────────────────────

    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const stalePlans = await db
      .select({ topic: notes.topic })
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

    const duration = Date.now() - sweepStart;
    logger.info(`Heartbeat completed in ${duration}ms`, {
      executed,
      failed,
      plansExpired,
      plansAbandoned,
    });

    return c.json({ ok: true, executed, failed, plansExpired, plansAbandoned, duration });
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
  const jobId = job.id;

  try {
    const planTopic = parseContinuationTag(job.description);
    const isContinuation = planTopic !== null;
    const isRecurring = !!job.cronSchedule;

    let prompt: string;
    let systemPrompt: string;
    let stepLimit: number;

    if (isContinuation) {
      const planContent = await loadPlanNote(planTopic);
      const nextSteps = job.description.replace(CONTINUE_TAG_RE, "");

      prompt = planContent
        ? `Plan note "${planTopic}":\n\n${planContent}\n\nNext steps to execute:\n${nextSteps}`
        : `Plan note "${planTopic}" not found. Original instructions:\n${nextSteps}`;

      systemPrompt = CONTINUATION_SYSTEM_PROMPT + skillIndex;
      stepLimit = 20;

      logger.info("Heartbeat: executing continuation", {
        jobId,
        planTopic,
        hasPlanNote: !!planContent,
      });
    } else {
      prompt = job.playbook
        ? `Job: ${job.name}\nDescription: ${job.description}\n\nPlaybook:\n${job.playbook}`
        : job.description;

      if (job.lastResult) {
        prompt += `\n\nPrevious result for context:\n${job.lastResult}`;
      }

      systemPrompt = JOB_SYSTEM_PROMPT + skillIndex;
      stepLimit = 15;

      logger.info("Heartbeat: executing job", {
        jobId,
        jobName: job.name,
        isRecurring,
        hasPlaybook: !!job.playbook,
      });
    }

    const model = await getMainModel();

    const { text } = await generateText({
      model,
      system: systemPrompt,
      prompt,
      tools: createSlackTools(slackClient, {
        userId: job.requestedBy,
        channelId: job.channelId || undefined,
        threadTs: job.threadTs || undefined,
      }),
      stopWhen: stepCountIs(stepLimit),
    });

    const result = (text || "Job completed (no text output)").substring(0, 2000);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const isNewDay = job.lastExecutionDate !== todayStr;

    if (isRecurring) {
      // Recurring: update stats, keep pending for next cycle
      await db
        .update(jobs)
        .set({
          executeAt: null,
          retries: 0,
          lastExecutedAt: now,
          executionCount: sql`${jobs.executionCount} + 1`,
          todayExecutions: isNewDay ? 1 : sql`${jobs.todayExecutions} + 1`,
          lastExecutionDate: todayStr,
          lastResult: result,
          updatedAt: now,
        })
        .where(eq(jobs.id, jobId));

      logger.info("Heartbeat: recurring job completed", {
        jobName: job.name,
      });
    } else {
      // One-shot or continuation: mark completed
      await db
        .update(jobs)
        .set({
          status: "completed",
          result,
          lastExecutedAt: now,
          executionCount: sql`${jobs.executionCount} + 1`,
          updatedAt: now,
        })
        .where(eq(jobs.id, jobId));

      logger.info("Heartbeat: one-shot job completed", {
        jobName: job.name,
        isContinuation,
      });
    }
  } catch (error: any) {
    // Retry logic
    const newRetries = job.retries + 1;

    if (newRetries < MAX_RETRIES) {
      const retryAt = new Date(Date.now() + RETRY_DELAY_MS);
      await db
        .update(jobs)
        .set({ executeAt: retryAt, retries: newRetries, updatedAt: new Date() })
        .where(eq(jobs.id, jobId));

      logger.warn("Heartbeat: job retrying", {
        jobName: job.name,
        retries: newRetries,
        retryAt: retryAt.toISOString(),
      });
    } else {
      await db
        .update(jobs)
        .set({
          status: "failed",
          result: `Failed after ${MAX_RETRIES} retries: ${error.message}`,
          retries: newRetries,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));

      // Escalate: DM the requester
      try {
        if (job.requestedBy && job.requestedBy !== "aura") {
          const dmResult = await slackClient.conversations.open({
            users: job.requestedBy,
          });
          if (dmResult.channel?.id) {
            await slackClient.chat.postMessage({
              channel: dmResult.channel.id,
              text: `I tried 3 times but couldn't complete this job: "${job.description}"\n\nError: ${error.message}`,
            });
          }
        }
      } catch {
        logger.error("Heartbeat: failed to send escalation DM", { jobId });
      }

      logger.error("Heartbeat: job failed permanently", {
        jobName: job.name,
        error: error.message,
      });
    }

    throw error;
  }
}

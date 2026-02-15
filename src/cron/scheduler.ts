import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { generateText, stepCountIs } from "ai";
import { eq, and, lte, sql } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { db } from "../db/client.js";
import { scheduledActions } from "../db/schema.js";
import { getMainModel } from "../lib/ai.js";
import { createSlackTools } from "../tools/slack.js";
import { logger } from "../lib/logger.js";

const botToken = process.env.SLACK_BOT_TOKEN || "";
const slackClient = new WebClient(botToken);

/** Max actions to process per sweep (stay within 300s function timeout) */
const MAX_ACTIONS_PER_SWEEP = 10;

/** Max retries before marking as failed */
const MAX_RETRIES = 3;

/** Retry delay in ms (10 minutes) */
const RETRY_DELAY_MS = 10 * 60 * 1000;

// ── Sweeper System Prompt ────────────────────────────────────────────────────

const SWEEPER_SYSTEM_PROMPT = `You are Aura executing a scheduled task autonomously. You have full access to your tools.

Rules:
- Execute the task described below. Use your tools to read channels, post messages, look up users, etc.
- Post results to the channel specified unless the task says otherwise.
- If you have "previous result" context, compare and highlight changes (e.g. "17 bugs yesterday, 22 today -- that's a spike").
- If you discover something urgent or unexpected, you can:
  - Schedule a follow-up check (schedule_action)
  - DM the person who requested this to escalate (send_direct_message)
  - Save findings to your notes for future reference (save_note / edit_note)
- If the task no longer makes sense (channel deleted, user gone, etc.), note that in your result.
- Be concise. Digests and summaries, not essays.
- Do NOT respond conversationally. Just execute the task and report.`;

// ── Scheduler Cron App ───────────────────────────────────────────────────────

export const schedulerApp = new Hono();

schedulerApp.get("/api/cron/scheduler", async (c) => {
  // Verify cron secret
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("Unauthorized scheduler cron invocation");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const sweepStart = Date.now();
  logger.info("Scheduler sweep starting");

  try {
    // Query due actions: pending, execute_at <= now, ordered by priority then time
    const dueActions = await db
      .select()
      .from(scheduledActions)
      .where(
        and(
          eq(scheduledActions.status, "pending"),
          lte(scheduledActions.executeAt, new Date()),
        ),
      )
      .orderBy(
        sql`CASE WHEN ${scheduledActions.priority} = 'high' THEN 0 WHEN ${scheduledActions.priority} = 'normal' THEN 1 ELSE 2 END`,
        scheduledActions.executeAt,
      )
      .limit(MAX_ACTIONS_PER_SWEEP);

    if (dueActions.length === 0) {
      logger.info("Scheduler sweep: no due actions");
      return c.json({ ok: true, processed: 0 });
    }

    logger.info(`Scheduler sweep: ${dueActions.length} due actions`);

    let processed = 0;
    let failed = 0;

    for (const action of dueActions) {
      try {
        await executeAction(action);
        processed++;
      } catch (error: any) {
        logger.error("Scheduler: action execution failed", {
          actionId: action.id,
          error: error.message,
        });
        failed++;
      }
    }

    const duration = Date.now() - sweepStart;
    logger.info(`Scheduler sweep completed in ${duration}ms`, {
      processed,
      failed,
    });

    return c.json({ ok: true, processed, failed, duration });
  } catch (error: any) {
    logger.error("Scheduler sweep failed", { error: error.message });
    return c.json({ error: "Sweep failed" }, 500);
  }
});

// ── Action Execution ─────────────────────────────────────────────────────────

async function executeAction(action: typeof scheduledActions.$inferSelect) {
  const actionId = action.id;

  try {
    // Build the prompt with context from previous executions
    let prompt = action.description;
    if (action.lastResult) {
      prompt += `\n\nPrevious result for context:\n${action.lastResult}`;
    }

    const model = await getMainModel();

    const { text } = await generateText({
      model,
      system: SWEEPER_SYSTEM_PROMPT,
      prompt,
      tools: createSlackTools(slackClient, {
        userId: action.requestedBy,
        channelId: action.channelId,
      }),
      stopWhen: stepCountIs(15),
    });

    const result = text || "Task completed (no text output)";

    // Mark as completed
    await db
      .update(scheduledActions)
      .set({ status: "completed", result })
      .where(eq(scheduledActions.id, actionId));

    logger.info("Scheduler: action completed", {
      actionId,
      description: action.description.substring(0, 80),
    });

    // Handle recurring: compute next occurrence and insert
    if (action.recurring) {
      await scheduleNextOccurrence(action, result);
    }
  } catch (error: any) {
    const newRetries = action.retries + 1;

    if (newRetries < MAX_RETRIES) {
      // Retry: push back 10 minutes
      const retryAt = new Date(Date.now() + RETRY_DELAY_MS);
      await db
        .update(scheduledActions)
        .set({
          executeAt: retryAt,
          retries: newRetries,
        })
        .where(eq(scheduledActions.id, actionId));

      logger.warn("Scheduler: action retrying", {
        actionId,
        retries: newRetries,
        retryAt: retryAt.toISOString(),
      });
    } else {
      // Exhausted retries: mark failed and escalate
      await db
        .update(scheduledActions)
        .set({
          status: "failed",
          result: `Failed after ${MAX_RETRIES} retries: ${error.message}`,
          retries: newRetries,
        })
        .where(eq(scheduledActions.id, actionId));

      // Try to DM the requester about the failure
      try {
        if (action.requestedBy && action.requestedBy !== "aura") {
          const dmResult = await slackClient.conversations.open({
            users: action.requestedBy,
          });
          if (dmResult.channel?.id) {
            await slackClient.chat.postMessage({
              channel: dmResult.channel.id,
              text: `I tried 3 times but couldn't complete this scheduled task: "${action.description}"\n\nError: ${error.message}`,
            });
          }
        }
      } catch {
        logger.error("Scheduler: failed to send escalation DM", { actionId });
      }

      logger.error("Scheduler: action failed permanently", {
        actionId,
        error: error.message,
      });
    }
  }
}

// ── Recurring: Compute Next Occurrence ───────────────────────────────────────

async function scheduleNextOccurrence(
  action: typeof scheduledActions.$inferSelect,
  lastResult: string,
) {
  try {
    const interval = CronExpressionParser.parse(action.recurring!, {
      currentDate: new Date(),
      tz: action.timezone,
    });

    const nextDate = interval.next().toDate();

    await db.insert(scheduledActions).values({
      description: action.description,
      executeAt: nextDate,
      channelId: action.channelId,
      threadTs: action.threadTs,
      requestedBy: action.requestedBy,
      recurring: action.recurring,
      timezone: action.timezone,
      priority: action.priority,
      lastResult: lastResult.substring(0, 2000), // cap at 2k chars
    });

    logger.info("Scheduler: next recurring occurrence scheduled", {
      description: action.description.substring(0, 80),
      nextAt: nextDate.toISOString(),
      timezone: action.timezone,
    });
  } catch (error: any) {
    logger.error("Scheduler: failed to compute next occurrence", {
      recurring: action.recurring,
      timezone: action.timezone,
      error: error.message,
    });
  }
}

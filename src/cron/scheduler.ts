import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { generateText, stepCountIs } from "ai";
import { eq, and, lte, sql } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { db } from "../db/client.js";
import { scheduledActions, notes } from "../db/schema.js";
import { getMainModel } from "../lib/ai.js";
import { createSlackTools } from "../tools/slack.js";
import { buildSkillIndex } from "../lib/skill-index.js";
import { logger } from "../lib/logger.js";

const botToken = process.env.SLACK_BOT_TOKEN || "";
const slackClient = new WebClient(botToken);

/** Max actions to process per sweep (stay within 300s function timeout) */
const MAX_ACTIONS_PER_SWEEP = 10;

/** Max retries before marking as failed */
const MAX_RETRIES = 3;

/** Retry delay in ms (10 minutes) */
const RETRY_DELAY_MS = 10 * 60 * 1000;

// ── System Prompts ───────────────────────────────────────────────────────────

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

const CONTINUATION_SYSTEM_PROMPT = `You are Aura resuming a multi-step task. Your accumulated progress and context are below.

Rules:
- Continue from where you left off. The plan note contains your progress, next steps, and context.
- If you can't finish in this round, use checkpoint_plan again to save progress and schedule another continuation.
- Post results in the thread you're continuing (routing is automatic).
- Be concise and focused. Don't re-explain what was already done — just continue the work.
- If the continuation depth limit is reached, explain your current status and ask if you should keep going.`;

// ── Continuation Detection ───────────────────────────────────────────────────

const CONTINUE_TAG_RE = /^\[CONTINUE:([^\]]+)\]\s*/;

/**
 * Check if an action description is a continuation and extract the plan topic.
 */
function parseContinuationTag(description: string): string | null {
  const match = description.match(CONTINUE_TAG_RE);
  return match ? match[1] : null;
}

/**
 * Load a plan note's content directly from the DB.
 */
async function loadPlanNote(topic: string): Promise<string | null> {
  const rows = await db
    .select({ content: notes.content })
    .from(notes)
    .where(eq(notes.topic, topic))
    .limit(1);
  return rows[0]?.content ?? null;
}

// ── Scheduler Cron App ───────────────────────────────────────────────────────

export const schedulerApp = new Hono();

schedulerApp.get("/api/cron/scheduler", async (c) => {
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("Unauthorized scheduler cron invocation");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const sweepStart = Date.now();
  logger.info("Scheduler sweep starting");

  try {
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
    const planTopic = parseContinuationTag(action.description);
    const isContinuation = planTopic !== null;

    let prompt: string;
    let systemPrompt: string;
    let stepLimit: number;

    if (isContinuation) {
      // Load plan note and inject into prompt
      const planContent = await loadPlanNote(planTopic);
      const nextSteps = action.description.replace(CONTINUE_TAG_RE, "");
      const skillIndex = await buildSkillIndex();

      prompt = planContent
        ? `Plan note "${planTopic}":\n\n${planContent}\n\nNext steps to execute:\n${nextSteps}`
        : `Plan note "${planTopic}" not found. Original instructions:\n${nextSteps}`;

      systemPrompt = CONTINUATION_SYSTEM_PROMPT + skillIndex;
      stepLimit = 20;

      logger.info("Scheduler: executing continuation", {
        actionId,
        planTopic,
        hasPlanNote: !!planContent,
      });
    } else {
      // Regular action
      prompt = action.description;
      if (action.lastResult) {
        prompt += `\n\nPrevious result for context:\n${action.lastResult}`;
      }
      const skillIndex = await buildSkillIndex();
      systemPrompt = SWEEPER_SYSTEM_PROMPT + skillIndex;
      stepLimit = 15;
    }

    const model = await getMainModel();

    const { text } = await generateText({
      model,
      system: systemPrompt,
      prompt,
      tools: createSlackTools(slackClient, {
        userId: action.requestedBy,
        channelId: action.channelId,
        threadTs: action.threadTs || undefined,
      }),
      stopWhen: stepCountIs(stepLimit),
    });

    const result = text || "Task completed (no text output)";

    await db
      .update(scheduledActions)
      .set({ status: "completed", result })
      .where(eq(scheduledActions.id, actionId));

    logger.info("Scheduler: action completed", {
      actionId,
      description: action.description.substring(0, 80),
      isContinuation,
    });

    if (action.recurring) {
      await scheduleNextOccurrence(action, result);
    }
  } catch (error: any) {
    const newRetries = action.retries + 1;

    if (newRetries < MAX_RETRIES) {
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
      await db
        .update(scheduledActions)
        .set({
          status: "failed",
          result: `Failed after ${MAX_RETRIES} retries: ${error.message}`,
          retries: newRetries,
        })
        .where(eq(scheduledActions.id, actionId));

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
      lastResult: lastResult.substring(0, 2000),
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

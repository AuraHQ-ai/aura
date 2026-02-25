import { WebClient } from "@slack/web-api";
import { generateText, stepCountIs } from "ai";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { jobs, notes, jobExecutions } from "../db/schema.js";
import { getMainModel, getEscalationModel, withCacheControl } from "../lib/ai.js";
import { createSlackTools } from "../tools/slack.js";
import { logger } from "../lib/logger.js";
import { safePostMessage } from "../lib/slack-messaging.js";
import { createHeadlessPrepareStep, HEADLESS_STEP_LIMIT } from "../pipeline/prepare-step.js";

const botToken = process.env.SLACK_BOT_TOKEN || "";
const slackClient = new WebClient(botToken);

/** Max retries before marking as failed */
export const MAX_RETRIES = 3;

/** Retry delay in ms (30 minutes — matches heartbeat cron interval) */
const RETRY_DELAY_MS = 30 * 60 * 1000;

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

// ── Job Execution ────────────────────────────────────────────────────────────

export async function executeJob(
  job: typeof jobs.$inferSelect,
  skillIndex: string,
  trigger: "heartbeat" | "dispatch" | "continuation" = "heartbeat",
): Promise<boolean> {
  const jobId = job.id;

  // Atomically claim the job to prevent duplicate execution.
  // If another process already claimed it, this updates 0 rows.
  const claimed = await db
    .update(jobs)
    .set({ status: "running", updatedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "pending")))
    .returning({ id: jobs.id });

  if (claimed.length === 0) {
    logger.info("executeJob: job already claimed, skipping", { jobId, jobName: job.name });
    return false;
  }

  // Insert execution trace row
  const [execution] = await db
    .insert(jobExecutions)
    .values({
      jobId,
      status: "running",
      trigger,
      callbackChannel: job.channelId || null,
      callbackThreadTs: job.threadTs || null,
    })
    .returning({ id: jobExecutions.id });

  const executionId = execution.id;

  try {
    const planTopic = parseContinuationTag(job.description);
    const isContinuation = planTopic !== null;
    const isRecurring = !!job.cronSchedule || !!job.frequencyConfig;

    const effectiveTrigger = isContinuation && trigger === "heartbeat" ? "continuation" : trigger;
    if (effectiveTrigger !== trigger) {
      await db
        .update(jobExecutions)
        .set({ trigger: effectiveTrigger })
        .where(eq(jobExecutions.id, executionId));
    }

    let prompt: string;
    let systemPrompt: string;

    if (isContinuation) {
      const planContent = await loadPlanNote(planTopic);
      const nextSteps = job.description.replace(CONTINUE_TAG_RE, "");

      prompt = planContent
        ? `Plan note "${planTopic}":\n\n${planContent}\n\nNext steps to execute:\n${nextSteps}`
        : `Plan note "${planTopic}" not found. Original instructions:\n${nextSteps}`;

      systemPrompt = CONTINUATION_SYSTEM_PROMPT + skillIndex;

      logger.info("Heartbeat: executing continuation", {
        jobId,
        executionId,
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

      logger.info("Heartbeat: executing job", {
        jobId,
        executionId,
        jobName: job.name,
        isRecurring,
        hasPlaybook: !!job.playbook,
        trigger: effectiveTrigger,
      });
    }

    const { modelId, model } = await getMainModel();

    const slackTools = createSlackTools(slackClient, {
      userId: job.requestedBy,
      channelId: job.channelId || undefined,
      threadTs: job.threadTs || undefined,
    });

    const generateResult = await generateText({
      model,
      system: withCacheControl(systemPrompt),
      prompt,
      tools: slackTools,
      stopWhen: stepCountIs(HEADLESS_STEP_LIMIT),
      prepareStep: createHeadlessPrepareStep({
        systemPrompt,
        modelId,
        defaultEffort: "medium",
        getEscalationModel,
      }),
    });

    const { text, steps, totalUsage: usage } = generateResult;

    const serializedSteps = steps.map((step) => ({
      type: step.finishReason,
      text: step.text,
      toolCalls: step.toolCalls?.map((tc) => ({
        toolName: tc.toolName,
        input: tc.input,
      })),
      toolResults: step.toolResults?.map((tr) => ({
        toolName: tr.toolName,
        output: tr.output,
      })),
    }));

    const tokenUsage = {
      input: usage.inputTokens,
      output: usage.outputTokens,
      total: usage.totalTokens,
    };

    // Update execution trace with results
    await db
      .update(jobExecutions)
      .set({
        status: "completed",
        finishedAt: new Date(),
        steps: serializedSteps,
        tokenUsage,
        summary: (text || "").substring(0, 500) || null,
      })
      .where(eq(jobExecutions.id, executionId));

    const result = (text || "Job completed (no text output)").substring(0, 2000);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const isNewDay = job.lastExecutionDate !== todayStr;

    if (isRecurring) {
      await db
        .update(jobs)
        .set({
          status: "pending",
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
        executionId,
      });
    } else {
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
        executionId,
        isContinuation,
      });
    }

    return true;
  } catch (error: any) {
    // Update execution trace with failure (protected so it can't break retry logic)
    try {
      await db
        .update(jobExecutions)
        .set({
          status: "failed",
          finishedAt: new Date(),
          error: error.message,
        })
        .where(eq(jobExecutions.id, executionId));
    } catch (traceErr: any) {
      logger.error("executeJob: failed to update execution trace", {
        jobId,
        executionId,
        error: traceErr.message,
      });
    }

    // Retry logic
    const newRetries = job.retries + 1;

    if (newRetries < MAX_RETRIES) {
      const retryAt = new Date(Date.now() + RETRY_DELAY_MS);
      await db
        .update(jobs)
        .set({ status: "pending", executeAt: retryAt, retries: newRetries, updatedAt: new Date() })
        .where(eq(jobs.id, jobId));

      logger.warn("Heartbeat: job retrying", {
        jobName: job.name,
        executionId,
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
            await safePostMessage(slackClient, {
              channel: dmResult.channel.id,
              text: `I tried 3 times but couldn't complete this job: "${job.description}"\n\nError: ${error.message}`,
            });
          }
        }
      } catch {
        logger.error("Heartbeat: failed to send escalation DM", { jobId, executionId });
      }

      logger.error("Heartbeat: job failed permanently", {
        jobName: job.name,
        executionId,
        error: error.message,
      });
    }

    throw error;
  }
}

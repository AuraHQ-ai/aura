import { WebClient } from "@slack/web-api";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { jobs, notes, jobExecutions } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { safePostMessage } from "../lib/slack-messaging.js";
import { createHeadlessAgent } from "../lib/agents.js";
import { executionContext, PendingApprovalError } from "../lib/tool.js";
import { getCurrentTimeContext } from "../lib/temporal.js";
import { buildStablePrefix } from "../personality/system-prompt.js";
import {
  createConversationTrace,
  persistConversationInputs,
  persistConversationSteps,
  persistConversationError,
  updateConversationTraceUsage,
  type Step as ConversationStep,
} from "./persist-conversation.js";
import type { StepUsage } from "../lib/cost-calculator.js";
import type { DetailedTokenUsage } from "@aura/db/schema";

const botToken = process.env.SLACK_BOT_TOKEN || "";
const slackClient = new WebClient(botToken);

/** Max retries before marking as failed */
export const MAX_RETRIES = 3;

/** Retry delay in ms (30 minutes — matches heartbeat cron interval) */
const RETRY_DELAY_MS = 30 * 60 * 1000;

// ── Job-specific additive instructions ───────────────────────────────────────

const JOB_SPECIFIC_INSTRUCTIONS = `## Job execution mode

You are executing a scheduled job autonomously. Additional rules for this mode:
- Execute the task described below using your tools.
- Post results to the specified channel unless the task says otherwise.
- If you have "previous result" context, compare and highlight changes.
- If you discover something urgent, escalate via DM or create a follow-up job.
- Be concise. Digests and summaries, not essays.`;

const CONTINUATION_SPECIFIC_INSTRUCTIONS = `## Continuation mode

You are resuming a multi-step task. Your accumulated progress and context are below. Additional rules for this mode:
- Continue from where you left off. The plan note contains your progress, next steps, and context.
- If you can't finish in this round, use checkpoint_plan again to save progress and schedule another continuation.
- Post results in the thread you're continuing (routing is automatic).
- Be concise and focused. Don't re-explain what was already done -- just continue the work.
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

  // Tracks next message order_index; set by persistConversationInputs,
  // used by error handler if generate throws.
  let conversationOrderIndex = 0;
  let conversationId: string | undefined;

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

    const credentialIds = job.requiredCredentialIds ?? [];
    const credentialNote =
      credentialIds.length > 0
        ? `\n\nAuthorized credential IDs for this job: ${credentialIds.join(", ")}`
        : "";

    const stablePrefix = await buildStablePrefix();
    const timeContext = getCurrentTimeContext(job.timezone);

    if (isContinuation) {
      const planContent = await loadPlanNote(planTopic);
      const nextSteps = job.description.replace(CONTINUE_TAG_RE, "");

      prompt = planContent
        ? `Plan note "${planTopic}":\n\n${planContent}\n\nNext steps to execute:\n${nextSteps}${credentialNote}`
        : `Plan note "${planTopic}" not found. Original instructions:\n${nextSteps}${credentialNote}`;

      systemPrompt = stablePrefix + "\n\n" + timeContext + "\n\n" + CONTINUATION_SPECIFIC_INSTRUCTIONS;

      logger.info("Heartbeat: executing continuation", {
        jobId,
        executionId,
        planTopic,
        hasPlanNote: !!planContent,
        credentialCount: credentialIds.length,
      });
    } else {
      prompt = job.playbook
        ? `Job: ${job.name}\nDescription: ${job.description}\n\nPlaybook:\n${job.playbook}${credentialNote}`
        : `${job.description}${credentialNote}`;

      if (job.lastResult) {
        prompt += `\n\nPrevious result for context:\n${job.lastResult}`;
      }

      systemPrompt = stablePrefix + "\n\n" + timeContext + "\n\n" + JOB_SPECIFIC_INSTRUCTIONS;

      logger.info("Heartbeat: executing job", {
        jobId,
        executionId,
        jobName: job.name,
        isRecurring,
        hasPlaybook: !!job.playbook,
        trigger: effectiveTrigger,
        credentialCount: credentialIds.length,
      });
    }

    // Inject reply-routing so the agent posts results back to the originating thread/channel
    if (job.channelId && job.threadTs) {
      prompt += `\n\nIMPORTANT: Post your results using send_thread_reply(channel="${job.channelId}", thread_ts="${job.threadTs}"). If your response is too long for one message, post the first part with send_thread_reply, then post each continuation ALSO with send_thread_reply(channel="${job.channelId}", thread_ts="${job.threadTs}") — all parts in the same thread. Do NOT call send_direct_message.`;
    } else if (job.channelId) {
      prompt += `\n\nIMPORTANT: Post your results to channel "${job.channelId}" using send_channel_message. Do NOT use send_direct_message.`;
    }

    const { agent, modelId } = await createHeadlessAgent({
      slackClient,
      context: {
        userId: job.requestedBy,
        channelId: job.channelId || undefined,
        threadTs: job.threadTs || undefined,
      },
      systemPrompt,
    });

    // Create a conversation trace for this job execution
    conversationId = await createConversationTrace({
      sourceType: "job_execution",
      jobExecutionId: executionId,
      modelId,
    });

    // Phase 1: persist the exact inputs BEFORE calling generate.
    // If the process crashes mid-execution, we still have what was sent.
    conversationOrderIndex = await persistConversationInputs(
      conversationId,
      systemPrompt,
      prompt,
    );

    const generateResult = await executionContext.run(
      {
        triggeredBy: job.requestedBy,
        triggerType: "scheduled_job",
        jobId: job.id,
      },
      () => agent.generate({ prompt }),
    );

    const { text, steps, totalUsage: usage } = generateResult;

    // Phase 2a: persist assistant steps now that generate succeeded
    const conversationSteps: ConversationStep[] = steps.map((step) => ({
      text: step.text,
      reasoning: Array.isArray((step as any).reasoning) ? (step as any).reasoning : undefined,
      toolCalls: step.toolCalls?.map((tc) => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input,
      })),
      toolResults: step.toolResults?.map((tr) => ({
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        output: tr.output,
      })),
      finishReason: step.finishReason,
      modelId: step.response?.modelId,
      usage: step.usage ? {
        inputTokens: step.usage.inputTokens ?? 0,
        outputTokens: step.usage.outputTokens ?? 0,
        totalTokens: step.usage.totalTokens ?? 0,
        inputTokenDetails: step.usage.inputTokenDetails,
        outputTokenDetails: step.usage.outputTokenDetails,
      } : undefined,
    }));
    await persistConversationSteps(conversationId, conversationSteps, conversationOrderIndex);

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

    const tokenUsage: DetailedTokenUsage = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      inputTokenDetails: usage.inputTokenDetails,
      outputTokenDetails: usage.outputTokenDetails,
    };

    const stepUsages: StepUsage[] = steps
      .filter((step) => step.response?.modelId && step.usage)
      .map((step) => ({
        modelId: step.response!.modelId!,
        usage: {
          inputTokens: step.usage!.inputTokens ?? 0,
          outputTokens: step.usage!.outputTokens ?? 0,
          totalTokens: step.usage!.totalTokens ?? 0,
          inputTokenDetails: step.usage!.inputTokenDetails,
          outputTokenDetails: step.usage!.outputTokenDetails,
        },
      }));

    // Update trace with token usage + cost
    await updateConversationTraceUsage(conversationId, tokenUsage, stepUsages);

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
    // Persist the error in conversation history regardless of error type
    if (conversationId) {
      await persistConversationError(conversationId, error, conversationOrderIndex);
    }

    // Governance: if a tool requires approval, suspend the job
    if (error instanceof PendingApprovalError) {
      try {
        await db
          .update(jobExecutions)
          .set({
            status: "failed",
            finishedAt: new Date(),
            error: `Awaiting approval: ${error.actionLogId}`,
          })
          .where(eq(jobExecutions.id, executionId));
      } catch { /* non-critical */ }

      await db
        .update(jobs)
        .set({
          status: "pending",
          approvalStatus: "awaiting_approval",
          pendingActionLogId: error.actionLogId,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));

      logger.info("executeJob: job suspended awaiting approval", {
        jobId,
        jobName: job.name,
        actionLogId: error.actionLogId,
      });
      return true;
    }

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

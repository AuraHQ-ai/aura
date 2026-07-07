import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { generateObject } from "ai";
import { db } from "../db/client.js";
import { getFastModel } from "../lib/ai.js";
import { getCredential } from "../lib/credentials.js";
import { logger } from "../lib/logger.js";
import { aiTelemetry, withTrace } from "../lib/langfuse.js";
import { jobExecutions, jobOutcomes, jobs } from "@aura/db/schema";
import { sendJobFailureDm, truncateJobFailureText } from "./job-notifications.js";

const SUPERVISOR_LLM_TIMEOUT_MS = 60_000;
const MAX_SUPERVISOR_ATTEMPTS = 3;
const DEFAULT_PUBLIC_URL = "https://aura-alpha-five.vercel.app";
const GITHUB_REPO = "AuraHQ-ai/aura";
const GITHUB_ISSUE_LABEL = "auto-supervisor-fix";

const supervisorRequestSchema = z.object({
  outcomeId: z.string().uuid(),
});

const supervisorDecisionSchema = z.object({
  decision: z.enum([
    "retry_as_is",
    "retry_with_fix",
    "silent_success",
    "report_success",
    "report_failure",
    "escalate",
    "disable_job",
  ]),
  reasoning: z.string().min(1).max(4_000),
  user_message: z.string().max(2_000).optional(),
});

type SupervisorDecision = z.infer<typeof supervisorDecisionSchema>;
type ClaimedOutcome = typeof jobOutcomes.$inferSelect;
type JobRow = typeof jobs.$inferSelect;
type JobExecutionRow = typeof jobExecutions.$inferSelect;

type SupervisorContext = {
  outcome: ClaimedOutcome;
  job: JobRow;
  executions: JobExecutionRow[];
};

export const supervisorApp = new Hono();

function getPublicBaseUrl(): string {
  if (process.env.AURA_PUBLIC_URL) {
    return process.env.AURA_PUBLIC_URL.replace(/\/+$/, "");
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`.replace(/\/+$/, "");
  }
  if (process.env.VERCEL_URL) {
    const host = process.env.VERCEL_URL;
    const protocol = host.includes("localhost") ? "http" : "https";
    return `${protocol}://${host}`.replace(/\/+$/, "");
  }
  return DEFAULT_PUBLIC_URL;
}

function jobLink(jobId: string): string {
  return `${getPublicBaseUrl()}/jobs/${jobId}`;
}

function jsonForPrompt(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, nestedValue) => {
      if (nestedValue instanceof Date) return nestedValue.toISOString();
      return nestedValue;
    },
    2,
  );
}

function truncateForPrompt(value: string, maxChars = 12_000): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n... [truncated]`;
}

function invocationIdFromHeader(headerValue: string | undefined): string {
  return headerValue?.trim() || crypto.randomUUID();
}

async function acquireSupervisorLock(
  outcomeId: string,
  invocationId: string,
): Promise<ClaimedOutcome | null> {
  const [outcome] = await db
    .update(jobOutcomes)
    .set({
      supervisorStatus: "in_progress",
      supervisorInvocationId: invocationId,
      supervisorStartedAt: new Date(),
      supervisorAttempts: sql`${jobOutcomes.supervisorAttempts} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jobOutcomes.id, outcomeId),
        eq(jobOutcomes.supervisorStatus, "pending_review"),
      ),
    )
    .returning();

  return outcome ?? null;
}

async function loadSupervisorContext(outcome: ClaimedOutcome): Promise<SupervisorContext> {
  const [job] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.id, outcome.jobId))
    .limit(1);

  if (!job) {
    throw new Error(`Job not found for supervisor outcome ${outcome.id}`);
  }

  const executions = await db
    .select()
    .from(jobExecutions)
    .where(eq(jobExecutions.jobId, outcome.jobId))
    .orderBy(desc(jobExecutions.startedAt))
    .limit(5);

  return { outcome, job, executions };
}

async function runSupervisorLlm(context: SupervisorContext): Promise<SupervisorDecision> {
  const model = await getFastModel();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), SUPERVISOR_LLM_TIMEOUT_MS);

  try {
    const { object } = await withTrace(
      {
        traceName: "supervisor-decision",
        sessionId: context.job.threadTs || context.job.channelId || context.job.id,
        userId: context.job.requestedBy,
        tags: [
          "channel:supervisor",
          ...(context.job.channelId ? [`slack-channel:${context.job.channelId}`] : []),
        ],
        metadata: {
          slackUserId: context.job.requestedBy,
          jobId: context.job.id,
          outcomeId: context.outcome.id,
        },
      },
      () =>
        generateObject({
          model,
          schema: supervisorDecisionSchema,
          telemetry: aiTelemetry("supervisor-decision"),
          instructions:
            "You are Aura's job execution supervisor. Make one conservative decision from the provided fixed enum. Return only the structured object. Do not call tools.",
          prompt: truncateForPrompt(`Review this completed job outcome and decide the next action.

Decision meanings:
- silent_success: outcome succeeded cleanly and should be resolved with no DM. This is the default for routine recurring runs when cron_schedule is set and notify_on_success is false.
- report_success: outcome succeeded and the requester should be told. Reserve this for noteworthy success: a job that had been failing recovered, the first successful run after a code change, or notify_on_success is true. One-shot jobs with no cron_schedule should usually report success.
- report_failure: outcome failed in a way the requester should know about; do not retry.
- retry_as_is: transient failure or likely timeout; retry immediately without changing the job.
- retry_with_fix: likely Aura code/config bug; retry now and create an engineering issue.
- escalate: ambiguous, high-risk, or needs human judgment.
- disable_job: the job is harmful, obsolete, or repeatedly broken and should be disabled.

Context:
${jsonForPrompt({
  outcome: {
    id: context.outcome.id,
    status: context.outcome.outcomeStatus,
    error: context.outcome.error,
    output: context.outcome.output,
    last_n_steps: context.outcome.lastNSteps,
    created_at: context.outcome.createdAt,
  },
  job: {
    id: context.job.id,
    name: context.job.name,
    description: context.job.description,
    playbook: context.job.playbook,
    script: context.job.script,
    status: context.job.status,
    retries: context.job.retries,
    enabled: context.job.enabled,
    requested_by: context.job.requestedBy,
    cron_schedule: context.job.cronSchedule,
    notify_on_success: context.job.notifyOnSuccess,
    frequency_config: context.job.frequencyConfig,
    last_result: context.job.lastResult,
  },
  last_5_executions: context.executions.map((execution) => ({
    id: execution.id,
    status: execution.status,
    trigger: execution.trigger,
    started_at: execution.startedAt,
    finished_at: execution.finishedAt,
    summary: execution.summary,
    error: execution.error,
  })),
})}`),
          temperature: 0,
          abortSignal: abortController.signal,
        }),
    );

    return object;
  } finally {
    clearTimeout(timer);
  }
}

async function sendSupervisorDm(
  job: JobRow,
  text: string,
  logContext: Record<string, unknown> = {},
): Promise<void> {
  await sendJobFailureDm({
    jobId: job.id,
    requestedBy: job.requestedBy,
    text,
    logContext: { event: "job_supervisor", ...logContext },
  });
}

async function sendFounderDm(job: JobRow, text: string): Promise<void> {
  const founderUserId = process.env.FOUNDER_USER_ID?.trim() || job.requestedBy;
  if (!founderUserId || founderUserId === job.requestedBy) return;

  await sendJobFailureDm({
    jobId: job.id,
    requestedBy: founderUserId,
    text,
    logContext: { event: "job_supervisor_founder_escalation" },
  });
}

function buildUserMessage(decision: SupervisorDecision, fallback: string): string {
  return decision.user_message?.trim() || fallback;
}

async function createSupervisorFixIssue(
  context: SupervisorContext,
  decision: SupervisorDecision,
): Promise<string> {
  const ghToken = await getCredential("github_token");
  if (!ghToken) {
    throw new Error("GitHub token not configured for supervisor fix issue creation");
  }

  const issueBody = [
    `Supervisor decision: \`${decision.decision}\``,
    "",
    "## Reasoning",
    decision.reasoning,
    "",
    "## Job",
    `- id: ${context.job.id}`,
    `- name: ${context.job.name}`,
    `- requested_by: ${context.job.requestedBy}`,
    "",
    "## Outcome",
    `- id: ${context.outcome.id}`,
    `- status: ${context.outcome.outcomeStatus}`,
    `- error: ${context.outcome.error ?? "none"}`,
    "",
    "## last_n_steps",
    "```json",
    jsonForPrompt(context.outcome.lastNSteps ?? []),
    "```",
  ].join("\n");

  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `token ${ghToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      title: `Supervisor fix needed: ${context.job.name}`,
      body: issueBody,
      labels: [GITHUB_ISSUE_LABEL],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`GitHub issue creation failed (${response.status}): ${errorText}`);
  }

  const issue = (await response.json()) as { html_url?: string };
  if (!issue.html_url) {
    throw new Error("GitHub issue creation response did not include html_url");
  }

  return issue.html_url;
}

async function applySupervisorDecision(
  context: SupervisorContext,
  decision: SupervisorDecision,
): Promise<void> {
  const now = new Date();
  const link = jobLink(context.job.id);

  switch (decision.decision) {
    case "silent_success": {
      return;
    }

    case "report_success": {
      await sendSupervisorDm(
        context.job,
        `${buildUserMessage(decision, `Job \`${context.job.name}\` completed successfully.`)}\n\nDetails: ${link}`,
        { outcomeId: context.outcome.id, decision: decision.decision },
      );
      return;
    }

    case "report_failure": {
      const error = truncateJobFailureText(context.outcome.error);
      await sendSupervisorDm(
        context.job,
        `${buildUserMessage(decision, `Job \`${context.job.name}\` failed.`)}\n\nError: ${error}\nDetails: ${link}`,
        { outcomeId: context.outcome.id, decision: decision.decision },
      );
      return;
    }

    case "retry_as_is": {
      await db
        .update(jobs)
        .set({ status: "pending", retries: 0, executeAt: now, updatedAt: now })
        .where(eq(jobs.id, context.job.id));
      await sendSupervisorDm(
        context.job,
        `${buildUserMessage(decision, `Job \`${context.job.name}\` looked retryable, so I queued it to run again now.`)}\n\nDetails: ${link}`,
        { outcomeId: context.outcome.id, decision: decision.decision },
      );
      return;
    }

    case "retry_with_fix": {
      await db
        .update(jobs)
        .set({ status: "pending", retries: 0, executeAt: now, updatedAt: now })
        .where(eq(jobs.id, context.job.id));
      const issueUrl = await createSupervisorFixIssue(context, decision);
      await sendSupervisorDm(
        context.job,
        `${buildUserMessage(decision, `Job \`${context.job.name}\` was queued to retry and I opened an engineering follow-up.`)}\n\nIssue: ${issueUrl}\nDetails: ${link}`,
        { outcomeId: context.outcome.id, decision: decision.decision, issueUrl },
      );
      return;
    }

    case "escalate": {
      const text = `${buildUserMessage(decision, `Job \`${context.job.name}\` needs human review.`)}\n\nReason: ${decision.reasoning}\nDetails: ${link}`;
      await sendSupervisorDm(context.job, text, {
        outcomeId: context.outcome.id,
        decision: decision.decision,
      });
      await sendFounderDm(context.job, text);
      return;
    }

    case "disable_job": {
      await db
        .update(jobs)
        .set({ enabled: 0, updatedAt: now })
        .where(eq(jobs.id, context.job.id));
      await sendSupervisorDm(
        context.job,
        `${buildUserMessage(decision, `Job \`${context.job.name}\` was disabled by the supervisor.`)}\n\nReason: ${decision.reasoning}\nDetails: ${link}`,
        { outcomeId: context.outcome.id, decision: decision.decision },
      );
      return;
    }
  }
}

async function finalizeOutcome(
  outcomeId: string,
  decision: SupervisorDecision,
): Promise<void> {
  await db
    .update(jobOutcomes)
    .set({
      supervisorStatus: "resolved",
      supervisorDecision: decision.decision,
      supervisorReasoning: decision.reasoning,
      updatedAt: new Date(),
    })
    .where(eq(jobOutcomes.id, outcomeId));
}

async function releaseOutcomeForRetry(outcome: ClaimedOutcome | null, error: unknown): Promise<void> {
  if (!outcome) return;

  const errorMessage = error instanceof Error ? error.message : String(error);
  const maxAttemptsExceeded = outcome.supervisorAttempts >= MAX_SUPERVISOR_ATTEMPTS;

  await db
    .update(jobOutcomes)
    .set({
      supervisorStatus: maxAttemptsExceeded ? "skipped" : "pending_review",
      supervisorReasoning: maxAttemptsExceeded
        ? "max supervisor attempts exceeded"
        : `Supervisor failed: ${errorMessage}`,
      updatedAt: new Date(),
    })
    .where(eq(jobOutcomes.id, outcome.id));
}

async function skipMaxAttempts(outcome: ClaimedOutcome): Promise<void> {
  await db
    .update(jobOutcomes)
    .set({
      supervisorStatus: "skipped",
      supervisorReasoning: "max supervisor attempts exceeded",
      updatedAt: new Date(),
    })
    .where(eq(jobOutcomes.id, outcome.id));
}

supervisorApp.post("/api/cron/supervisor", async (c) => {
  const authHeader = c.req.header("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("Unauthorized supervisor cron invocation");
    return c.json({ error: "Unauthorized" }, 401);
  }

  let outcomeId: string;
  try {
    const parsed = supervisorRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "outcomeId required" }, 400);
    }
    outcomeId = parsed.data.outcomeId;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const invocationId = invocationIdFromHeader(c.req.header("x-vercel-id"));
  let claimedOutcome: ClaimedOutcome | null = null;

  try {
    claimedOutcome = await acquireSupervisorLock(outcomeId, invocationId);
    if (!claimedOutcome) {
      return c.json({ ok: true, skipped: true, reason: "already_claimed" });
    }

    if (claimedOutcome.supervisorAttempts >= MAX_SUPERVISOR_ATTEMPTS) {
      await skipMaxAttempts(claimedOutcome);
      return c.json({ ok: true, skipped: true, reason: "max_supervisor_attempts_exceeded" });
    }

    const context = await loadSupervisorContext(claimedOutcome);
    const decision = await runSupervisorLlm(context);
    await applySupervisorDecision(context, decision);
    await finalizeOutcome(claimedOutcome.id, decision);

    return c.json({ ok: true, outcomeId, decision: decision.decision });
  } catch (error) {
    logger.error("Supervisor invocation failed", {
      outcomeId,
      invocationId,
      error: error instanceof Error ? error.message : String(error),
    });
    await releaseOutcomeForRetry(claimedOutcome, error);
    return c.json({ ok: false, error: "Supervisor failed" }, 500);
  }
});

import { tool } from "ai";
import { z } from "zod";
import { eq, and, or, desc, isNotNull, ne, sql } from "drizzle-orm";
import type { WebClient } from "@slack/web-api";
import { CronExpressionParser } from "cron-parser";
import { db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import type { FrequencyConfig, ScheduleContext } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { parseRelativeTime } from "../lib/temporal.js";

// ── Channel Resolution ───────────────────────────────────────────────────────

export async function resolveChannelByName(
  client: WebClient,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const cleanName = name.replace(/^#/, "").toLowerCase();
  let cursor: string | undefined;

  do {
    const result = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });

    const match = result.channels?.find(
      (ch) => ch.name?.toLowerCase() === cleanName,
    );
    if (match && match.id && match.name) {
      return { id: match.id, name: match.name };
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return null;
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

/**
 * Create unified job tools for the AI SDK.
 * Jobs are the single execution primitive: one-shot reminders, recurring autonomous work,
 * and continuations all live in the same table and are processed by the heartbeat.
 */
export function createJobTools(
  client: WebClient,
  context?: ScheduleContext,
) {
  return {
    create_job: tool({
      description:
        "Create a one-shot task, recurring job, or follow-up. This is the single tool for scheduling anything: reminders, monitoring, digests, follow-ups, and autonomous work. One-shots fire once; recurring jobs run on a cron schedule with optional frequency limits.",
      inputSchema: z.object({
        name: z
          .string()
          .optional()
          .describe(
            "Unique job name, e.g. 'bug-digest' or 'remind-joan-pr'. Auto-generated for one-shots if omitted.",
          ),
        description: z
          .string()
          .describe(
            "What to do when the job fires. Be specific — this is the prompt the LLM will execute. E.g. 'Check #bugs for new reports and post a summary' or 'Remind Joan to review the PR'",
          ),
        playbook: z
          .string()
          .optional()
          .describe(
            "Step-by-step execution guide (markdown). For complex recurring jobs. The heartbeat uses this as the prompt.",
          ),
        execute_in: z
          .string()
          .optional()
          .describe(
            "When to first execute. Relative time: '30 minutes', '2 hours', '1 day', 'tomorrow'. Required for one-shots.",
          ),
        recurring: z
          .string()
          .optional()
          .describe(
            "Cron expression for recurring jobs, e.g. '0 9 * * 1-5' (weekdays 9 AM). Leave empty for one-shot.",
          ),
        channel_name: z
          .string()
          .optional()
          .describe(
            "Channel to post results in, e.g. 'general' or '#bugs'. Omit for DM-only or internal jobs.",
          ),
        timezone: z
          .string()
          .default("UTC")
          .describe("IANA timezone for the cron schedule, e.g. 'Europe/Zurich'. Defaults to UTC."),
        priority: z
          .enum(["high", "normal", "low"])
          .default("normal")
          .describe("Execution priority. High-priority jobs run first."),
        min_interval_hours: z
          .number()
          .optional()
          .describe("Minimum hours between executions (recurring jobs)"),
        max_per_day: z
          .number()
          .optional()
          .describe("Max executions per day (recurring jobs)"),
      }),
      execute: async ({
        name,
        description,
        playbook,
        execute_in,
        recurring,
        channel_name,
        timezone,
        priority,
        min_interval_hours,
        max_per_day,
      }) => {
        try {
          // Resolve channel
          let channelId: string | null = null;
          let channelLabel = "DM-routed";
          if (channel_name) {
            const channel = await resolveChannelByName(client, channel_name);
            if (!channel) {
              return { ok: false, error: `Could not find channel "${channel_name}".` };
            }
            channelId = channel.id;
            channelLabel = `#${channel.name}`;
          }

          // Validate cron expression
          if (recurring) {
            try {
              CronExpressionParser.parse(recurring);
            } catch {
              return {
                ok: false,
                error: `Invalid cron expression "${recurring}". Use standard 5-field syntax, e.g. '0 9 * * 1-5'.`,
              };
            }
          }

          // Compute executeAt
          let executeAt: Date | null = null;
          if (execute_in) {
            const delayMs = parseRelativeTime(execute_in);
            if (!delayMs) {
              return {
                ok: false,
                error: `Could not parse time "${execute_in}". Use formats like "30 minutes", "2 hours", "1 day", "tomorrow".`,
              };
            }
            executeAt = new Date(Date.now() + delayMs);
          } else if (recurring) {
            // First occurrence: compute from cron
            const interval = CronExpressionParser.parse(recurring, {
              currentDate: new Date(),
              tz: timezone,
            });
            executeAt = interval.next().toDate();
          }

          if (!executeAt && !recurring) {
            return {
              ok: false,
              error: "One-shot jobs require execute_in. Recurring jobs require a cron expression via recurring.",
            };
          }

          // Build frequency config (only meaningful for recurring jobs)
          const frequencyConfig: FrequencyConfig | null =
            recurring && (min_interval_hours != null || max_per_day != null)
              ? {
                  ...(min_interval_hours != null && { minIntervalHours: min_interval_hours }),
                  ...(max_per_day != null && { maxPerDay: max_per_day }),
                }
              : null;

          // Auto-generate name for one-shots if not provided
          const jobName = name || `job-${Date.now().toString(36)}`;
          const requestedBy = context?.userId || "aura";

          // Build update set for upsert (only update fields that were provided)
          const updateSet: Record<string, unknown> = {
            description,
            updatedAt: new Date(),
            status: "pending",
            enabled: 1,
            retries: 0,
          };
          if (playbook !== undefined) updateSet.playbook = playbook || null;
          if (recurring !== undefined) updateSet.cronSchedule = recurring || null;
          if (frequencyConfig !== null) updateSet.frequencyConfig = frequencyConfig;
          if (channel_name !== undefined) updateSet.channelId = channelId;
          if (executeAt) updateSet.executeAt = executeAt;
          updateSet.timezone = timezone;
          updateSet.priority = priority;

          await db
            .insert(jobs)
            .values({
              name: jobName,
              description,
              playbook: playbook || null,
              cronSchedule: recurring || null,
              frequencyConfig,
              channelId: channelId || "",
              executeAt,
              requestedBy,
              timezone,
              priority,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: jobs.name,
              set: updateSet,
            });

          const timeStr = executeAt?.toISOString() ?? "next cron window";
          const recurStr = recurring
            ? ` (recurring: ${recurring} ${timezone})`
            : " (one-shot)";

          logger.info("create_job tool called", {
            name: jobName,
            description: description.substring(0, 80),
            executeAt: timeStr,
            recurring,
            requestedBy,
          });

          return {
            ok: true,
            message: `Job "${jobName}" created${recurStr}. First execution: ${timeStr}.${channelId ? ` Posts to ${channelLabel}.` : ""}`,
            name: jobName,
            execute_at: timeStr,
          };
        } catch (error: any) {
          logger.error("create_job tool failed", { error: error.message });
          return { ok: false, error: `Failed to create job: ${error.message}` };
        }
      },
    }),

    list_jobs: tool({
      description:
        "List jobs by status. See what's pending, completed, or failed. Shows both one-shot tasks and recurring jobs.",
      inputSchema: z.object({
        status: z
          .enum(["pending", "completed", "failed", "cancelled"])
          .default("pending")
          .describe("Filter by status"),
        recurring_only: z
          .boolean()
          .default(false)
          .describe("If true, only show recurring jobs (not one-shots)"),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe("Maximum number of jobs to return"),
      }),
      execute: async ({ status, recurring_only, limit }) => {
        try {
          const conditions = [eq(jobs.status, status)];
          if (recurring_only) {
            conditions.push(
              and(isNotNull(jobs.cronSchedule), ne(jobs.cronSchedule, ""))!,
            );
          }

          const rows = await db
            .select()
            .from(jobs)
            .where(and(...conditions))
            .orderBy(desc(jobs.createdAt))
            .limit(limit);

          const filtered = rows;

          const result = filtered.map((j) => ({
            id: j.id,
            name: j.name,
            description: j.description.substring(0, 120),
            enabled: j.enabled === 1,
            is_recurring: !!j.cronSchedule,
            cron_schedule: j.cronSchedule,
            frequency_config: j.frequencyConfig,
            execute_at: j.executeAt?.toISOString() ?? null,
            channel_id: j.channelId || null,
            requested_by: j.requestedBy,
            priority: j.priority,
            status: j.status,
            retries: j.retries,
            last_executed_at: j.lastExecutedAt?.toISOString() ?? null,
            execution_count: j.executionCount,
            has_playbook: !!j.playbook,
            last_result: j.lastResult ? j.lastResult.substring(0, 200) : null,
          }));

          logger.info("list_jobs tool called", { status, count: result.length });

          return { ok: true, jobs: result, count: result.length };
        } catch (error: any) {
          logger.error("list_jobs tool failed", { error: error.message });
          return { ok: false, error: `Failed to list jobs: ${error.message}` };
        }
      },
    }),

    cancel_job: tool({
      description:
        "Cancel a pending one-shot job, or disable a recurring job (preserves its definition for re-enabling later). Accepts a job ID or name.",
      inputSchema: z.object({
        job_id: z
          .string()
          .optional()
          .describe("The UUID of the job to cancel"),
        name: z
          .string()
          .optional()
          .describe("The name of the job to cancel (alternative to job_id)"),
      }),
      execute: async ({ job_id, name }) => {
        try {
          if (!job_id && !name) {
            return { ok: false, error: "Provide either job_id or name." };
          }

          const condition = job_id
            ? eq(jobs.id, job_id)
            : eq(jobs.name, name!);

          const rows = await db
            .select()
            .from(jobs)
            .where(condition)
            .limit(1);

          if (rows.length === 0) {
            return { ok: false, error: `No job found with ${job_id ? `ID "${job_id}"` : `name "${name}"`}.` };
          }

          const job = rows[0];

          if (job.cronSchedule) {
            // Recurring job: disable instead of cancelling (preserves definition)
            await db
              .update(jobs)
              .set({ enabled: 0, updatedAt: new Date() })
              .where(condition);

            logger.info("cancel_job: disabled recurring job", { name: job.name });
            return {
              ok: true,
              message: `Recurring job "${job.name}" disabled. Use create_job with the same name to re-enable.`,
            };
          } else {
            // One-shot: only cancel if still pending
            if (job.status !== "pending") {
              return {
                ok: false,
                error: `Job "${job.name}" is already ${job.status} and cannot be cancelled.`,
              };
            }

            await db
              .update(jobs)
              .set({ status: "cancelled", updatedAt: new Date() })
              .where(condition);

            logger.info("cancel_job: cancelled one-shot", { name: job.name });
            return {
              ok: true,
              message: `Job "${job.name}" cancelled.`,
            };
          }
        } catch (error: any) {
          logger.error("cancel_job tool failed", { error: error.message });
          return { ok: false, error: `Failed to cancel job: ${error.message}` };
        }
      },
    }),
  };
}

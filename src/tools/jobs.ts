import { tool } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { WebClient } from "@slack/web-api";
import { CronExpressionParser } from "cron-parser";
import { db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import type { FrequencyConfig } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { resolveChannelByName } from "./schedule.js";

// ── Tool Definitions ─────────────────────────────────────────────────────────

/**
 * Create job management tools for the AI SDK.
 * Jobs are autonomous recurring work that the heartbeat executes.
 */
export function createJobTools(client: WebClient) {
  return {
    create_job: tool({
      description:
        "Create or update a recurring job. Jobs are autonomous work Aura executes during heartbeats. Upserts by name. New jobs are enabled by default.",
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            "Unique job name, e.g. 'bug-digest' or 'stale-user-audit'",
          ),
        description: z
          .string()
          .describe("What this job does and why it matters"),
        playbook: z
          .string()
          .optional()
          .describe(
            "Step-by-step execution guide (markdown). This is the prompt the heartbeat uses.",
          ),
        cron_schedule: z
          .string()
          .optional()
          .describe(
            "Cron expression if time-based, e.g. '0 9 * * 1-5'. Omit for heartbeat-triggered.",
          ),
        min_interval_hours: z
          .number()
          .optional()
          .describe("Minimum hours between executions"),
        max_per_day: z
          .number()
          .optional()
          .describe("Max executions per day"),
        channel_name: z
          .string()
          .optional()
          .describe(
            "Channel to post results in, e.g. '#engineering'. Omit for internal-only jobs.",
          ),
      }),
      execute: async ({
        name,
        description,
        playbook,
        cron_schedule,
        min_interval_hours,
        max_per_day,
        channel_name,
      }) => {
        try {
          let channelId: string | null = null;
          if (channel_name) {
            const channel = await resolveChannelByName(client, channel_name);
            if (!channel) {
              return {
                ok: false,
                error: `Could not find channel "${channel_name}".`,
              };
            }
            channelId = channel.id;
          }

          // Validate cron expression before saving
          if (cron_schedule) {
            try {
              CronExpressionParser.parse(cron_schedule);
            } catch {
              return {
                ok: false,
                error: `Invalid cron expression "${cron_schedule}". Use standard 5-field cron syntax, e.g. '0 9 * * 1-5'.`,
              };
            }
          }

          const frequencyConfig: FrequencyConfig | null =
            min_interval_hours != null || max_per_day != null
              ? {
                  ...(min_interval_hours != null && { minIntervalHours: min_interval_hours }),
                  ...(max_per_day != null && { maxPerDay: max_per_day }),
                }
              : null;

          // Build update set dynamically so omitted optional fields
          // preserve existing values rather than being wiped to null.
          const updateSet: Record<string, unknown> = {
            description,
            updatedAt: new Date(),
          };
          if (playbook !== undefined) {
            updateSet.playbook = playbook || null;
          }
          if (cron_schedule !== undefined) {
            updateSet.cronSchedule = cron_schedule || null;
          }
          if (frequencyConfig !== null) {
            updateSet.frequencyConfig = frequencyConfig;
          }
          if (channel_name !== undefined) {
            updateSet.channelId = channelId;
          }

          await db
            .insert(jobs)
            .values({
              name,
              description,
              playbook: playbook || null,
              cronSchedule: cron_schedule || null,
              frequencyConfig,
              channelId,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: jobs.name,
              set: updateSet,
            });

          logger.info("create_job tool called", { name, description: description.substring(0, 80) });

          return {
            ok: true,
            message: `Job "${name}" saved.${channelId ? ` Posts to channel.` : " Internal only."}${cron_schedule ? ` Schedule: ${cron_schedule}` : " Heartbeat-triggered."}`,
          };
        } catch (error: any) {
          logger.error("create_job tool failed", {
            name,
            error: error.message,
          });
          return { ok: false, error: `Failed to create job: ${error.message}` };
        }
      },
    }),

    list_jobs: tool({
      description:
        "List all jobs with their status, last execution, and frequency config.",
      inputSchema: z.object({
        enabled_only: z
          .boolean()
          .default(false)
          .describe("If true, only show enabled jobs"),
      }),
      execute: async ({ enabled_only }) => {
        try {
          let query = db.select().from(jobs);
          if (enabled_only) {
            query = query.where(eq(jobs.enabled, 1)) as typeof query;
          }
          const rows = await query.orderBy(jobs.name);

          const result = rows.map((j) => ({
            name: j.name,
            description: j.description,
            enabled: j.enabled === 1,
            cron_schedule: j.cronSchedule,
            frequency_config: j.frequencyConfig,
            channel_id: j.channelId,
            last_executed_at: j.lastExecutedAt?.toISOString() ?? null,
            execution_count: j.executionCount,
            has_playbook: !!j.playbook,
          }));

          logger.info("list_jobs tool called", { count: result.length });

          return { ok: true, jobs: result, count: result.length };
        } catch (error: any) {
          logger.error("list_jobs tool failed", { error: error.message });
          return { ok: false, error: `Failed to list jobs: ${error.message}` };
        }
      },
    }),

    enable_job: tool({
      description:
        "Enable a disabled job so it runs on the next heartbeat.",
      inputSchema: z.object({
        name: z.string().describe("The name of the job to enable"),
      }),
      execute: async ({ name }) => {
        try {
          const rows = await db
            .select()
            .from(jobs)
            .where(eq(jobs.name, name))
            .limit(1);

          if (rows.length === 0) {
            return { ok: false, error: `No job found with name "${name}".` };
          }

          await db
            .update(jobs)
            .set({ enabled: 1, updatedAt: new Date() })
            .where(eq(jobs.name, name));

          logger.info("enable_job tool called", { name });
          return { ok: true, message: `Job "${name}" enabled.` };
        } catch (error: any) {
          logger.error("enable_job tool failed", {
            name,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to enable job: ${error.message}`,
          };
        }
      },
    }),

    disable_job: tool({
      description:
        "Disable a job so it stops running. The job definition is preserved.",
      inputSchema: z.object({
        name: z.string().describe("The name of the job to disable"),
      }),
      execute: async ({ name }) => {
        try {
          const rows = await db
            .select()
            .from(jobs)
            .where(eq(jobs.name, name))
            .limit(1);

          if (rows.length === 0) {
            return { ok: false, error: `No job found with name "${name}".` };
          }

          await db
            .update(jobs)
            .set({ enabled: 0, updatedAt: new Date() })
            .where(eq(jobs.name, name));

          logger.info("disable_job tool called", { name });
          return {
            ok: true,
            message: `Job "${name}" disabled. It won't run until re-enabled.`,
          };
        } catch (error: any) {
          logger.error("disable_job tool failed", {
            name,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to disable job: ${error.message}`,
          };
        }
      },
    }),
  };
}

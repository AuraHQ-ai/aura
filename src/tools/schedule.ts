import { tool } from "ai";
import { z } from "zod";
import { eq, and, lte, desc } from "drizzle-orm";
import type { WebClient } from "@slack/web-api";
import { db } from "../db/client.js";
import { scheduledActions } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { parseRelativeTime } from "../lib/temporal.js";

// ── Channel Resolution (lightweight, uses WebClient) ─────────────────────────

async function resolveChannelByName(
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

export interface ScheduleContext {
  userId?: string;
  channelId?: string;
  threadTs?: string;
}

/**
 * Create scheduling tools for the AI SDK.
 */
export function createScheduleTools(
  client: WebClient,
  context?: ScheduleContext,
) {
  return {
    schedule_action: tool({
      description:
        "Schedule a one-shot or recurring task. For one-shot: fires once after the specified delay. For recurring: fires on a cron schedule. Use this for reminders, monitoring, digests, follow-ups, and routines.",
      inputSchema: z.object({
        description: z
          .string()
          .describe(
            "What to do when the action fires. Be specific -- this is the prompt the LLM will execute. E.g. 'Check #bugs for new reports and post a summary in #general' or 'Remind Joan to review the PR'",
          ),
        execute_in: z
          .string()
          .describe(
            "When to first execute. Relative time: '30 minutes', '2 hours', '1 day', 'tomorrow'. Required for one-shot, used as first occurrence for recurring.",
          ),
        channel_name: z
          .string()
          .optional()
          .describe(
            "Channel to post results in, e.g. 'general' or '#bugs'. Optional -- omit for DM-only actions where the description specifies a DM target.",
          ),
        recurring: z
          .string()
          .optional()
          .describe(
            "Cron expression for recurring tasks, e.g. '0 9 * * 1-5' (weekdays 9 AM), '0 10 * * 1' (Mondays 10 AM). Leave empty for one-shot.",
          ),
        timezone: z
          .string()
          .default("UTC")
          .describe(
            "IANA timezone for the cron schedule, e.g. 'Europe/Zurich', 'America/New_York'. Defaults to UTC.",
          ),
        priority: z
          .enum(["high", "normal", "low"])
          .default("normal")
          .describe("Priority level. High-priority actions are processed first."),
      }),
      execute: async ({
        description,
        execute_in,
        channel_name,
        recurring,
        timezone,
        priority,
      }) => {
        try {
          const delayMs = parseRelativeTime(execute_in);
          if (!delayMs) {
            return {
              ok: false,
              error: `Could not parse time "${execute_in}". Use formats like "30 minutes", "2 hours", "1 day", "tomorrow".`,
            };
          }

          let channelId = "";
          let channelLabel = "DM-routed";

          if (channel_name) {
            const channel = await resolveChannelByName(client, channel_name);
            if (!channel) {
              return {
                ok: false,
                error: `Could not find channel "${channel_name}".`,
              };
            }
            channelId = channel.id;
            channelLabel = `#${channel.name}`;
          }

          const executeAt = new Date(Date.now() + delayMs);
          const requestedBy = context?.userId || "aura";

          await db.insert(scheduledActions).values({
            description,
            executeAt,
            channelId,
            requestedBy,
            recurring: recurring || null,
            timezone,
            priority,
          });

          const timeStr = executeAt.toISOString();
          const recurStr = recurring
            ? ` (recurring: ${recurring} ${timezone})`
            : " (one-shot)";

          logger.info("schedule_action tool called", {
            description: description.substring(0, 80),
            executeAt: timeStr,
            recurring,
            channel: channelLabel,
            requestedBy,
          });

          return {
            ok: true,
            message: `Scheduled${recurStr}. First execution at ${timeStr}${channelId ? ` in ${channelLabel}` : " (DM-routed via description)"}.`,
            execute_at: timeStr,
          };
        } catch (error: any) {
          logger.error("schedule_action tool failed", {
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to schedule action: ${error.message}`,
          };
        }
      },
    }),

    list_scheduled_actions: tool({
      description:
        "List scheduled actions. See what's pending, completed, or failed. Use this to inspect and manage your own schedule.",
      inputSchema: z.object({
        status: z
          .enum(["pending", "completed", "failed", "cancelled"])
          .default("pending")
          .describe("Filter by status"),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe("Maximum number of actions to return"),
      }),
      execute: async ({ status, limit }) => {
        try {
          const rows = await db
            .select()
            .from(scheduledActions)
            .where(eq(scheduledActions.status, status))
            .orderBy(desc(scheduledActions.executeAt))
            .limit(limit);

          const actions = rows.map((r) => ({
            id: r.id,
            description: r.description,
            execute_at: r.executeAt.toISOString(),
            channel_id: r.channelId,
            requested_by: r.requestedBy,
            recurring: r.recurring,
            timezone: r.timezone,
            priority: r.priority,
            status: r.status,
            retries: r.retries,
            last_result: r.lastResult
              ? r.lastResult.substring(0, 200)
              : null,
          }));

          logger.info("list_scheduled_actions tool called", {
            status,
            count: actions.length,
          });

          return { ok: true, actions, count: actions.length };
        } catch (error: any) {
          logger.error("list_scheduled_actions tool failed", {
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to list actions: ${error.message}`,
          };
        }
      },
    }),

    cancel_scheduled_action: tool({
      description:
        "Cancel a pending scheduled action by ID. For recurring actions, this stops future occurrences.",
      inputSchema: z.object({
        action_id: z
          .string()
          .describe("The ID of the scheduled action to cancel"),
      }),
      execute: async ({ action_id }) => {
        try {
          const rows = await db
            .select()
            .from(scheduledActions)
            .where(
              and(
                eq(scheduledActions.id, action_id),
                eq(scheduledActions.status, "pending"),
              ),
            )
            .limit(1);

          if (rows.length === 0) {
            return {
              ok: false,
              error: `No pending action found with ID "${action_id}".`,
            };
          }

          await db
            .update(scheduledActions)
            .set({ status: "cancelled" })
            .where(eq(scheduledActions.id, action_id));

          logger.info("cancel_scheduled_action tool called", { action_id });

          return {
            ok: true,
            message: `Cancelled action: ${rows[0].description}`,
          };
        } catch (error: any) {
          logger.error("cancel_scheduled_action tool failed", {
            action_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to cancel action: ${error.message}`,
          };
        }
      },
    }),
  };
}

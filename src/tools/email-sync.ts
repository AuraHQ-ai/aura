import { tool } from "ai";
import { z } from "zod";
import { logger } from "../lib/logger.js";
import { isAdmin } from "../lib/permissions.js";
import type { ScheduleContext } from "../db/schema.js";

/**
 * Resolve a user display name / username to a Slack user ID.
 */
async function resolveSlackUserId(userName: string): Promise<string | null> {
  try {
    const { WebClient } = await import("@slack/web-api");
    const { getUserList } = await import("./slack.js");
    const client = new WebClient(process.env.SLACK_BOT_TOKEN);
    const users = await getUserList(client);

    const normalizedInput = userName.replace(/^@/, "").toLowerCase().trim();

    for (const user of users) {
      if (
        user.displayName.toLowerCase() === normalizedInput ||
        user.realName.toLowerCase() === normalizedInput ||
        user.username.toLowerCase() === normalizedInput
      ) {
        return user.id;
      }
    }

    for (const user of users) {
      if (
        user.displayName.toLowerCase().startsWith(normalizedInput) ||
        user.realName.toLowerCase().startsWith(normalizedInput) ||
        user.username.toLowerCase().startsWith(normalizedInput)
      ) {
        return user.id;
      }
    }

    return null;
  } catch (error: any) {
    logger.error("Failed to resolve Slack user ID", {
      userName,
      error: error.message,
    });
    return null;
  }
}

export function createEmailSyncTools(context?: ScheduleContext) {
  return {
    sync_emails: tool({
      description:
        "Trigger a full email sync for a user's Gmail account. Fetches all emails, converts HTML to markdown, and runs AI triage classification. Admin-only tool.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, or username of the Gmail account owner, e.g. 'Joan' or '@joan'",
          ),
        after: z
          .string()
          .optional()
          .describe("Only sync emails after this date (YYYY/MM/DD format). Defaults to 2025/01/01."),
        max_emails: z
          .number()
          .optional()
          .describe("Maximum number of emails to sync. Defaults to 5000."),
      }),
      execute: async ({ user_name, after, max_emails }) => {
        if (!isAdmin(context?.userId)) {
          return {
            ok: false,
            error: "This tool is restricted to admin users only.",
          };
        }

        try {
          const userId = await resolveSlackUserId(user_name);
          if (!userId) {
            return {
              ok: false,
              error: `Could not resolve Slack user '${user_name}'. Make sure they exist in the workspace.`,
            };
          }

          const { syncEmailsForUser } = await import("../lib/email-sync.js");
          const stats = await syncEmailsForUser(userId, {
            after,
            maxEmails: max_emails,
          });

          logger.info("sync_emails tool completed", {
            userId,
            ...stats,
          });

          return {
            ok: true,
            message: `Email sync complete for ${user_name}`,
            ...stats,
          };
        } catch (error: any) {
          logger.error("sync_emails tool failed", {
            user_name,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to sync emails: ${error.message}`,
          };
        }
      },
    }),

    email_digest: tool({
      description:
        "Get an email digest for a user showing threads awaiting reply, urgent items, and summary statistics from the synced email staging table.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, or username of the Gmail account owner",
          ),
        days: z
          .number()
          .optional()
          .default(7)
          .describe("How many days back to look (default 7)"),
      }),
      execute: async ({ user_name, days }) => {
        try {
          const userId = await resolveSlackUserId(user_name);
          if (!userId) {
            return {
              ok: false,
              error: `Could not resolve Slack user '${user_name}'.`,
            };
          }

          const { getThreadsAwaitingReply } = await import("../lib/email-sync.js");
          const { db } = await import("../db/client.js");
          const { emailsRaw } = await import("../db/schema.js");
          const { eq, and, gte, sql, count } = await import("drizzle-orm");

          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - days);

          // Threads awaiting reply
          const awaiting = await getThreadsAwaitingReply(userId);
          const recentAwaiting = awaiting.filter(
            (t) => t.lastDate >= cutoff,
          );

          // Summary stats
          const stats = await db
            .select({
              triage: emailsRaw.triage,
              total: count(),
            })
            .from(emailsRaw)
            .where(
              and(
                eq(emailsRaw.userId, userId),
                gte(emailsRaw.date, cutoff),
              ),
            )
            .groupBy(emailsRaw.triage);

          const totalEmails = stats.reduce((s, r) => s + Number(r.total), 0);
          const byTriage: Record<string, number> = {};
          for (const row of stats) {
            byTriage[row.triage || "untriaged"] = Number(row.total);
          }

          logger.info("email_digest tool called", {
            userId,
            days,
            awaitingReply: recentAwaiting.length,
            totalEmails,
          });

          return {
            ok: true,
            user: user_name,
            period_days: days,
            total_emails: totalEmails,
            by_triage: byTriage,
            threads_awaiting_reply: recentAwaiting.slice(0, 20).map((t) => ({
              thread_id: t.threadId,
              subject: t.subject,
              from: t.lastFrom,
              date: t.lastDate.toISOString(),
              triage: t.triage,
            })),
            urgent_count: recentAwaiting.filter((t) => t.triage === "urgent").length,
          };
        } catch (error: any) {
          logger.error("email_digest tool failed", {
            user_name,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to get email digest: ${error.message}`,
          };
        }
      },
    }),
  };
}

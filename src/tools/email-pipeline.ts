import { tool } from "ai";
import { z } from "zod";
import { logger } from "../lib/logger.js";

/**
 * Create email pipeline tools for syncing and triaging user emails.
 * These use the email staging pipeline (emails_raw table) rather than
 * hitting Gmail directly for each query.
 */
export function createEmailPipelineTools() {
  return {
    sync_user_emails: tool({
      description:
        "Sync a user's Gmail inbox into the emails_raw staging table and run AI triage. " +
        "Fetches all emails since a given date, converts HTML to markdown, classifies each " +
        "email as urgent/actionable/informational/noise using Claude Haiku. " +
        "The user must have granted Aura Gmail OAuth access. " +
        "Use this before running email_digest to ensure data is fresh.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, or username of the Gmail account owner, e.g. 'Joan' or '@joan'",
          ),
        days_back: z
          .number()
          .min(1)
          .max(90)
          .optional()
          .default(7)
          .describe(
            "How many days back to sync (default 7, max 90)",
          ),
        run_triage: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Whether to run AI triage after syncing (default true)",
          ),
      }),
      execute: async ({ user_name, days_back, run_triage }) => {
        try {
          const userId = await resolveSlackUserId(user_name);
          if (!userId) {
            return {
              ok: false,
              error: `Could not resolve Slack user '${user_name}'. Make sure they exist in the workspace.`,
            };
          }

          const { syncUserEmails, triageEmails } = await import(
            "../lib/email-pipeline.js"
          );

          const sinceDate = new Date();
          sinceDate.setDate(sinceDate.getDate() - days_back);

          const syncResult = await syncUserEmails(userId, sinceDate);

          let triageResult = { triaged: 0, errors: 0 };
          if (run_triage) {
            triageResult = await triageEmails(userId);
          }

          logger.info("sync_user_emails tool called", {
            userId,
            user_name,
            days_back,
            synced: syncResult.synced,
            triaged: triageResult.triaged,
          });

          return {
            ok: true,
            synced: syncResult.synced,
            sync_errors: syncResult.errors,
            triaged: triageResult.triaged,
            triage_errors: triageResult.errors,
            message: `Synced ${syncResult.synced} emails (${syncResult.errors} errors). Triaged ${triageResult.triaged} emails (${triageResult.errors} errors).`,
          };
        } catch (error: any) {
          logger.error("sync_user_emails tool failed", {
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
        "Produce an email digest from the emails_raw staging table. Shows: " +
        "(1) threads awaiting reply sorted by urgency, " +
        "(2) urgent items that may have been missed, " +
        "(3) summary counts by triage class. " +
        "Run sync_user_emails first if data might be stale.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "The display name, real name, or username of the Gmail account owner",
          ),
      }),
      execute: async ({ user_name }) => {
        try {
          const userId = await resolveSlackUserId(user_name);
          if (!userId) {
            return {
              ok: false,
              error: `Could not resolve Slack user '${user_name}'.`,
            };
          }

          const { getEmailDigest } = await import(
            "../lib/email-pipeline.js"
          );
          const digest = await getEmailDigest(userId);

          logger.info("email_digest tool called", {
            userId,
            user_name,
            awaitingReply: digest.awaitingReply.length,
            urgentMissed: digest.urgentMissed.length,
          });

          return {
            ok: true,
            awaiting_reply: digest.awaitingReply.map((t) => ({
              thread_id: t.gmailThreadId,
              subject: t.subject,
              latest_date: t.latestDate?.toISOString() || null,
              latest_from: t.latestFromEmail,
              triage_class: t.triageClass,
              message_count: t.messageCount,
            })),
            urgent_missed: digest.urgentMissed.map((e) => ({
              message_id: e.gmailMessageId,
              subject: e.subject,
              from: e.fromEmail,
              date: e.date?.toISOString() || null,
              triage_class: e.triageClass,
              reason: e.triageReason,
            })),
            summary: digest.summary,
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

/**
 * Resolve a user display name / username to a Slack user ID.
 * Reuses the paginated, cached getUserList from slack.ts.
 */
async function resolveSlackUserId(
  userName: string,
): Promise<string | null> {
  try {
    const { WebClient } = await import("@slack/web-api");
    const { getUserList } = await import("./slack.js");
    const client = new WebClient(process.env.SLACK_BOT_TOKEN);
    const users = await getUserList(client);

    const normalizedInput = userName
      .replace(/^@/, "")
      .toLowerCase()
      .trim();

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

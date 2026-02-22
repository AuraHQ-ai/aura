import { tool } from "ai";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { formatDistanceToNow } from "date-fns";
import type { WebClient } from "@slack/web-api";
import { logger } from "../lib/logger.js";
import { isAdmin } from "../lib/permissions.js";
import { db } from "../db/client.js";
import { emailsRaw } from "../db/schema.js";
import type { ScheduleContext } from "../db/schema.js";
import { resolveUserByName } from "./slack.js";

// ── Tool Definitions ────────────────────────────────────────────────────────

export function createEmailSyncTools(
  client: WebClient,
  context?: ScheduleContext,
) {
  return {
    sync_emails: tool({
      description:
        "Sync emails from a user's Gmail into the staging pipeline. Supports date windows (after/before), relative dates (newer_than), or raw Gmail queries. Resumable — re-running with the same query skips already-synced emails. Admin-only.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "Display name, username, or user ID of the Gmail account owner",
          ),
        after: z
          .string()
          .optional()
          .describe(
            "Gmail date filter, e.g. '2025/01/01'. Translated to 'after:<date>' query. Default: '2025/01/01'",
          ),
        before: z
          .string()
          .optional()
          .describe(
            "Gmail date filter, e.g. '2025/06/01'. Translated to 'before:<date>' query.",
          ),
        newer_than: z
          .string()
          .optional()
          .describe(
            "Gmail relative date filter, e.g. '7d', '30d', '1y'. Translated to 'newer_than:<value>' query.",
          ),
        query: z
          .string()
          .optional()
          .describe(
            "Raw Gmail search query override. If provided, ignores after/before/newer_than. E.g. 'from:investor@fund.com newer_than:30d'",
          ),
        max_messages: z
          .number()
          .optional()
          .describe(
            "Max messages to fetch per sync call. Default 500 for backfills. Use smaller values (50-100) for quick syncs.",
          ),
        triage: z
          .boolean()
          .optional()
          .describe("Run Haiku triage after sync (default true)"),
      }),
      execute: async ({
        user_name,
        after,
        before,
        newer_than,
        query: rawQuery,
        triage,
        max_messages,
      }) => {
        if (!isAdmin(context?.userId)) {
          return {
            ok: false,
            error: "This tool is restricted to admin users only.",
          };
        }

        try {
          const user = await resolveUserByName(client, user_name);
          if (!user) {
            return {
              ok: false,
              error: `Could not resolve user '${user_name}'. They need to exist in the workspace.`,
            };
          }

          const { syncEmails } = await import("../lib/email-sync.js");

          let gmailQuery: string;
          if (rawQuery) {
            gmailQuery = rawQuery;
          } else if (newer_than) {
            gmailQuery = `newer_than:${newer_than}`;
          } else {
            const afterDate = after || "2025/01/01";
            gmailQuery = `after:${afterDate}`;
            if (before) {
              gmailQuery += ` before:${before}`;
            }
          }

          const syncResult = await syncEmails(user.id, {
            query: gmailQuery,
            maxMessages: max_messages || 500,
          });

          let triageResult = null;
          let threadResult = null;
          if (triage !== false) {
            const { triageEmails } = await import("../lib/email-triage.js");
            triageResult = await triageEmails(user.id);

            const { computeThreadStates } = await import(
              "../lib/email-thread-state.js"
            );
            threadResult = await computeThreadStates(user.id);
          }

          return {
            ok: true,
            synced: syncResult.synced,
            skipped: syncResult.skipped,
            errors: syncResult.errors,
            triage: triageResult,
            threadStates: threadResult,
            message: `Synced ${syncResult.synced} emails (${syncResult.skipped} already existed, ${syncResult.errors} errors)${
              triageResult
                ? `, triaged ${triageResult.triaged} (${Object.entries(triageResult.breakdown)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(", ")})`
                : ""
            }${
              threadResult
                ? `, thread states: ${threadResult.threadsProcessed} threads (${Object.entries(threadResult.breakdown)
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(", ")})`
                : ""
            }`,
          };
        } catch (error: any) {
          logger.error("sync_emails tool failed", {
            userName: user_name,
            error: error.message,
          });
          return { ok: false, error: `Sync failed: ${error.message}` };
        }
      },
    }),

    email_digest: tool({
      description:
        "Get an email digest for a user: urgent items, threads awaiting reply, sorted by importance. Reads from the emails_raw staging table. Admin-only.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "Display name, username, or user ID of the Gmail account owner",
          ),
        include_fyi: z
          .boolean()
          .optional()
          .describe("Include FYI-level threads (default false)"),
      }),
      execute: async ({ user_name, include_fyi }) => {
        if (!isAdmin(context?.userId)) {
          return {
            ok: false,
            error: "This tool is restricted to admin users only.",
          };
        }

        try {
          const user = await resolveUserByName(client, user_name);
          if (!user) {
            return {
              ok: false,
              error: `Could not resolve user '${user_name}'.`,
            };
          }

          const userId = user.id;

          const triageStats = await db
            .select({
              triage: emailsRaw.triage,
              count: sql<number>`count(*)::int`,
            })
            .from(emailsRaw)
            .where(eq(emailsRaw.userId, userId))
            .groupBy(emailsRaw.triage);

          const statsMap: Record<string, number> = {};
          for (const s of triageStats) {
            statsMap[s.triage || "untriaged"] = s.count;
          }

          // Thread-state-aware query: aggregate per thread
          const threadRows = await db
            .select({
              gmailThreadId: emailsRaw.gmailThreadId,
              subject: sql<string>`(array_agg(${emailsRaw.subject} ORDER BY ${emailsRaw.date} DESC))[1]`,
              fromEmail: sql<string>`(array_agg(${emailsRaw.fromEmail} ORDER BY ${emailsRaw.date} DESC))[1]`,
              fromName: sql<string | null>`(array_agg(${emailsRaw.fromName} ORDER BY ${emailsRaw.date} DESC))[1]`,
              lastDate: sql<Date>`max(${emailsRaw.date})`,
              threadState: sql<string | null>`(array_agg(${emailsRaw.threadState} ORDER BY ${emailsRaw.date} DESC))[1]`,
              hasUrgent: sql<boolean>`bool_or(${emailsRaw.triage} = 'urgent')`,
              messageCount: sql<number>`count(*)::int`,
              participantCount: sql<number>`count(DISTINCT ${emailsRaw.fromEmail})::int`,
            })
            .from(emailsRaw)
            .where(
              and(
                eq(emailsRaw.userId, userId),
                include_fyi
                  ? sql`(${emailsRaw.threadState} IS NULL OR ${emailsRaw.threadState} NOT IN ('junk'))`
                  : sql`(${emailsRaw.threadState} IS NULL OR ${emailsRaw.threadState} NOT IN ('junk', 'fyi'))`,
              ),
            )
            .groupBy(emailsRaw.gmailThreadId)
            .orderBy(
              sql`bool_or(${emailsRaw.triage} = 'urgent') DESC`,
              sql`CASE (array_agg(${emailsRaw.threadState} ORDER BY ${emailsRaw.date} DESC))[1]
                WHEN 'awaiting_your_reply' THEN 1
                WHEN 'awaiting_their_reply' THEN 2
                WHEN 'fyi' THEN 3
                ELSE 4 END`,
              sql`max(${emailsRaw.date}) DESC`,
            )
            .limit(200);

          const threads = threadRows.map((t) => ({
            subject: t.subject || "(no subject)",
            from: t.fromName
              ? `${t.fromName} <${t.fromEmail}>`
              : t.fromEmail,
            thread_state: t.threadState || "unknown",
            has_urgent: t.hasUrgent,
            message_count: t.messageCount,
            participant_count: t.participantCount,
            last_message: t.lastDate
              ? formatDistanceToNow(t.lastDate, { addSuffix: true })
              : "unknown",
          }));

          const awaitingReply = threads.filter(
            (t) => t.thread_state === "awaiting_your_reply",
          );
          const awaitingTheirs = threads.filter(
            (t) => t.thread_state === "awaiting_their_reply",
          );
          const urgent = threads.filter((t) => t.has_urgent);
          const fyi = threads.filter((t) => t.thread_state === "fyi");

          let summary = `📧 **Email Digest** (${threads.length} threads)\n`;
          if (urgent.length > 0)
            summary += `🚨 **${urgent.length} urgent**\n`;
          if (awaitingReply.length > 0)
            summary += `📩 **${awaitingReply.length} awaiting your reply**\n`;
          if (awaitingTheirs.length > 0)
            summary += `📤 **${awaitingTheirs.length} awaiting their reply**\n`;
          if (fyi.length > 0) summary += `ℹ️ **${fyi.length} FYI**\n`;

          const priority = threads
            .filter((t) => t.has_urgent || t.thread_state === "awaiting_your_reply")
            .slice(0, 10);

          if (priority.length > 0) {
            summary += "\n**Priority threads:**\n";
            priority.forEach((t) => {
              const icon = t.has_urgent ? "🚨" : "📩";
              const meta = `${t.message_count} msg, ${t.participant_count} participants`;
              summary += `${icon} **${t.subject}** from ${t.from} • ${t.last_message} (${meta})\n`;
            });
          }

          return {
            ok: true,
            message: summary,
            stats: statsMap,
            threads,
            awaiting_reply_count: awaitingReply.length,
          };
        } catch (error: any) {
          logger.error("email_digest tool failed", {
            userName: user_name,
            error: error.message,
          });
          return { ok: false, error: `Digest failed: ${error.message}` };
        }
      },
    }),
  };
}

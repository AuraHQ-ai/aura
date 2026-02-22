import { tool } from "ai";
import { z } from "zod";
import { eq, and, desc, sql } from "drizzle-orm";
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
        "Sync recent emails from a user's Gmail into the staging pipeline. Fetches from Gmail, converts HTML to markdown, and stores in emails_raw. Optionally runs Haiku triage. The user must have authorized Aura to access their Gmail. Admin-only.",
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
        triage: z
          .boolean()
          .optional()
          .describe("Run Haiku triage after sync (default true)"),
      }),
      execute: async ({ user_name, after, triage }) => {
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
          const afterDate = after || "2025/01/01";
          const syncResult = await syncEmails(user.id, {
            query: `after:${afterDate}`,
            maxMessages: 100,
          });

          let triageResult = null;
          if (triage !== false) {
            const { triageEmails } = await import("../lib/email-triage.js");
            triageResult = await triageEmails(user.id);
          }

          return {
            ok: true,
            synced: syncResult.synced,
            skipped: syncResult.skipped,
            errors: syncResult.errors,
            triage: triageResult,
            message: `Synced ${syncResult.synced} emails (${syncResult.skipped} already existed, ${syncResult.errors} errors)${
              triageResult
                ? `, triaged ${triageResult.triaged} (${Object.entries(triageResult.breakdown)
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

          const emails = await db
            .select({
              gmailThreadId: emailsRaw.gmailThreadId,
              subject: emailsRaw.subject,
              fromEmail: emailsRaw.fromEmail,
              fromName: emailsRaw.fromName,
              date: emailsRaw.date,
              triage: emailsRaw.triage,
              triageReason: emailsRaw.triageReason,
              direction: emailsRaw.direction,
            })
            .from(emailsRaw)
            .where(
              and(
                eq(emailsRaw.userId, userId),
                include_fyi
                  ? sql`(${emailsRaw.triage} IS NULL OR ${emailsRaw.triage} != 'junk')`
                  : sql`(${emailsRaw.triage} IS NULL OR ${emailsRaw.triage} NOT IN ('junk', 'fyi'))`,
              ),
            )
            .orderBy(
              sql`CASE ${emailsRaw.triage}
                WHEN 'urgent' THEN 1
                WHEN 'actionable' THEN 2
                WHEN 'fyi' THEN 3
                WHEN 'junk' THEN 4
                ELSE 5 END`,
              desc(emailsRaw.date),
            )
            .limit(200);

          const threadMap = new Map<string, (typeof emails)[0]>();
          for (const email of emails) {
            const existing = threadMap.get(email.gmailThreadId);
            if (
              !existing ||
              (email.date && existing.date && email.date > existing.date)
            ) {
              threadMap.set(email.gmailThreadId, email);
            }
          }

          const threads = [...threadMap.values()].map((t) => ({
            subject: t.subject || "(no subject)",
            from: t.fromName
              ? `${t.fromName} <${t.fromEmail}>`
              : t.fromEmail,
            triage: t.triage || "untriaged",
            triage_reason: t.triageReason || "",
            direction: t.direction,
            last_message: t.date
              ? formatDistanceToNow(t.date, { addSuffix: true })
              : "unknown",
          }));

          const urgent = threads.filter((t) => t.triage === "urgent");
          const actionable = threads.filter((t) => t.triage === "actionable");
          const fyi = threads.filter((t) => t.triage === "fyi");
          const awaitingReply = threads.filter(
            (t) =>
              t.direction === "inbound" &&
              (t.triage === "urgent" || t.triage === "actionable"),
          );

          let summary = `📧 **Email Digest** (${threads.length} threads)\n`;
          if (urgent.length > 0)
            summary += `🚨 **${urgent.length} urgent**\n`;
          if (actionable.length > 0)
            summary += `⚡ **${actionable.length} actionable**\n`;
          if (fyi.length > 0) summary += `ℹ️ **${fyi.length} FYI**\n`;
          if (awaitingReply.length > 0)
            summary += `📩 **${awaitingReply.length} awaiting reply**\n`;

          if (urgent.length > 0 || actionable.length > 0) {
            summary += "\n**Priority threads:**\n";
            [...urgent, ...actionable].slice(0, 10).forEach((t) => {
              const icon = t.triage === "urgent" ? "🚨" : "⚡";
              summary += `${icon} **${t.subject}** from ${t.from} • ${t.last_message}\n`;
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

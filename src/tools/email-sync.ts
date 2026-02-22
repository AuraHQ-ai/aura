import { tool } from "ai";
import { z } from "zod";
import { eq, and, desc, sql } from "drizzle-orm";
import { formatDistanceToNow } from "date-fns";
import type { WebClient } from "@slack/web-api";
import { logger } from "../lib/logger.js";
import { db } from "../db/client.js";
import { emailsRaw } from "../db/schema.js";
import type { ScheduleContext } from "../db/schema.js";

// ── User Resolution Helper ──────────────────────────────────────────────────

async function resolveSlackUserId(
  client: WebClient,
  userName: string,
): Promise<string | null> {
  try {
    const { getUserList } = await import("./slack.js");
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

// ── Tool Definitions ────────────────────────────────────────────────────────

export function createEmailSyncTools(
  client: WebClient,
  _context?: ScheduleContext,
) {
  return {
    sync_emails: tool({
      description:
        "Sync recent emails from a user's Gmail into the staging pipeline. Fetches from Gmail, converts HTML to markdown, and stores in emails_raw. Optionally runs Haiku triage. The user must have authorized Aura to access their Gmail.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "Display name, username, or user ID of the Gmail account owner",
          ),
        query: z
          .string()
          .optional()
          .describe("Gmail search query, e.g. 'newer_than:7d' (default)"),
        max_messages: z
          .number()
          .optional()
          .describe("Max messages to fetch (default 100)"),
        run_triage: z
          .boolean()
          .optional()
          .describe("Run Haiku triage after sync (default true)"),
      }),
      execute: async ({ user_name, query, max_messages, run_triage }) => {
        try {
          const userId = await resolveSlackUserId(client, user_name);
          if (!userId) {
            return {
              ok: false,
              error: `Could not resolve user '${user_name}'. They need to exist in the workspace.`,
            };
          }

          // Dynamic import to avoid loading gmail on every request
          const { syncEmails } = await import("../lib/email-sync.js");
          const result = await syncEmails(userId, {
            query: query || "newer_than:7d",
            maxMessages: max_messages || 100,
          });

          // Optionally run Haiku triage
          let triageResult = null;
          if (run_triage !== false) {
            const { triageEmails } = await import("../lib/email-triage.js");
            triageResult = await triageEmails(userId);
          }

          return {
            ok: true,
            synced: result.synced,
            skipped: result.skipped,
            errors: result.errors,
            triage: triageResult,
            message: `Synced ${result.synced} emails (${result.skipped} already existed, ${result.errors} errors)${
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
        "Get an email digest for a user: urgent items, threads awaiting reply, sorted by importance. Reads from the emails_raw staging table.",
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
        try {
          const userId = await resolveSlackUserId(client, user_name);
          if (!userId) {
            return {
              ok: false,
              error: `Could not resolve user '${user_name}'.`,
            };
          }

          // Get triage stats
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

          // Get recent threads, grouped by gmail_thread_id, most recent first
          const emails = await db
            .select({
              gmailThreadId: emailsRaw.gmailThreadId,
              subject: emailsRaw.subject,
              fromEmail: emailsRaw.fromEmail,
              fromName: emailsRaw.fromName,
              date: emailsRaw.date,
              triage: emailsRaw.triage,
              triageReason: emailsRaw.triageReason,
            })
            .from(emailsRaw)
            .where(
              and(
                eq(emailsRaw.userId, userId),
                include_fyi
                  ? sql`1=1`
                  : sql`(${emailsRaw.triage} IS NULL OR ${emailsRaw.triage} != 'junk')`,
              ),
            )
            .orderBy(
              sql`CASE ${emailsRaw.triage}
                WHEN 'urgent' THEN 1
                WHEN 'actionable' THEN 2
                WHEN 'fyi' THEN 3
                WHEN 'junk' THEN 4
                ELSE 0 END`,
              desc(emailsRaw.date),
            )
            .limit(200);

          // Dedupe to latest per thread
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
            last_message: t.date
              ? formatDistanceToNow(t.date, { addSuffix: true })
              : "unknown",
          }));

          // Build summary
          const urgent = threads.filter((t) => t.triage === "urgent");
          const actionable = threads.filter((t) => t.triage === "actionable");
          const fyi = threads.filter((t) => t.triage === "fyi");

          let summary = `📧 **Email Digest** (${threads.length} threads)\n`;
          if (urgent.length > 0)
            summary += `🚨 **${urgent.length} urgent**\n`;
          if (actionable.length > 0)
            summary += `⚡ **${actionable.length} actionable**\n`;
          if (fyi.length > 0) summary += `ℹ️ **${fyi.length} FYI**\n`;

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

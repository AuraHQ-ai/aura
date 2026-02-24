import { tool } from "ai";
import { z } from "zod";
import { eq, and, desc, sql, inArray, ilike } from "drizzle-orm";
import { formatDistanceToNow } from "date-fns";
import type { WebClient } from "@slack/web-api";
import { logger } from "../lib/logger.js";
import { isAdmin } from "../lib/permissions.js";
import { db } from "../db/client.js";
import { emailsRaw } from "../db/schema.js";
import type { ScheduleContext } from "../db/schema.js";
import { resolveUserByName } from "./slack.js";
import { threadStateValues } from "../lib/email-triage.js";

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
        classify: z
          .boolean()
          .optional()
          .describe("Compute thread states after sync (default true)"),
      }),
      execute: async ({
        user_name,
        after,
        before,
        newer_than,
        query: rawQuery,
        classify,
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

          const LARGE_SYNC_THRESHOLD = 200;
          const shouldClassify = classify !== false;
          const isLargeSync = syncResult.synced >= LARGE_SYNC_THRESHOLD;

          let threadStates = null;
          if (shouldClassify && !isLargeSync) {
            const { computeThreadStates } = await import(
              "../lib/email-triage.js"
            );
            threadStates = await computeThreadStates(user.id);
          }

          const syncSummary = `Synced ${syncResult.synced} emails (${syncResult.skipped} already existed, ${syncResult.errors} errors)`;

          let message: string;
          if (threadStates) {
            message = `${syncSummary}, classified ${threadStates.processed} threads (${Object.entries(threadStates.breakdown)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ")})`;
          } else if (shouldClassify && isLargeSync) {
            message = `${syncSummary}. Large sync detected (${syncResult.synced} emails) — triage skipped for speed. Run sync_emails with classify=false then trigger triage separately, or re-run with a narrower date window.`;
          } else {
            message = syncSummary;
          }

          if (syncResult.errors > 0 && syncResult.errorDetails.length > 0) {
            const sample = syncResult.errorDetails.slice(0, 3);
            message += `\nError samples: ${sample.map((e) => `${e.gmailMessageId}: ${e.reason}`).join("; ")}`;
            if (syncResult.errorDetails.length > 3) {
              message += ` (and ${syncResult.errorDetails.length - 3} more)`;
            }
          }

          return {
            ok: true,
            synced: syncResult.synced,
            skipped: syncResult.skipped,
            errors: syncResult.errors,
            errorDetails: syncResult.errorDetails.slice(0, 20),
            threadStates,
            triageSkipped: shouldClassify && isLargeSync,
            message,
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

          // Get one representative state per thread (preferring non-null states)
          const stateStats = await db
            .select({
              threadState: sql<string | null>`COALESCE(
                MIN(CASE WHEN ${emailsRaw.threadState} IS NOT NULL THEN ${emailsRaw.threadState} END),
                NULL
              )`,
              count: sql<number>`1::int`,
            })
            .from(emailsRaw)
            .where(eq(emailsRaw.userId, userId))
            .groupBy(emailsRaw.gmailThreadId)
            .then((threadStates) => {
              // Now group by the representative state and count
              const stateCounts: { threadState: string | null; count: number }[] = [];
              const stateMap = new Map<string, number>();

              for (const { threadState } of threadStates) {
                const key = threadState || "unclassified";
                stateMap.set(key, (stateMap.get(key) || 0) + 1);
              }

              for (const [threadState, count] of stateMap.entries()) {
                stateCounts.push({
                  threadState: threadState === "unclassified" ? null : threadState,
                  count
                });
              }

              return stateCounts;
            });

          const statsMap: Record<string, number> = {};
          for (const s of stateStats) {
            statsMap[s.threadState || "unclassified"] = s.count;
          }

          const stateFilter = include_fyi
            ? sql`(${emailsRaw.threadState} IS NULL OR ${emailsRaw.threadState} != 'junk')`
            : sql`(${emailsRaw.threadState} IS NULL OR ${emailsRaw.threadState} NOT IN ('junk', 'fyi'))`;

          const emails = await db
            .select({
              gmailThreadId: emailsRaw.gmailThreadId,
              subject: emailsRaw.subject,
              fromEmail: emailsRaw.fromEmail,
              fromName: emailsRaw.fromName,
              date: emailsRaw.date,
              threadState: emailsRaw.threadState,
              threadStateReason: emailsRaw.threadStateReason,
              direction: emailsRaw.direction,
            })
            .from(emailsRaw)
            .where(
              and(
                eq(emailsRaw.userId, userId),
                stateFilter,
              ),
            )
            .orderBy(
              sql`CASE ${emailsRaw.threadState}
                WHEN 'awaiting_your_reply' THEN 1
                WHEN 'awaiting_their_reply' THEN 2
                WHEN 'fyi' THEN 3
                WHEN 'resolved' THEN 4
                WHEN 'junk' THEN 5
                ELSE 6 END`,
              desc(emailsRaw.date),
            )
            .limit(200);

          const threadMap = new Map<
            string,
            { latest: (typeof emails)[0]; count: number }
          >();
          for (const email of emails) {
            const existing = threadMap.get(email.gmailThreadId);
            if (!existing) {
              threadMap.set(email.gmailThreadId, {
                latest: email,
                count: 1,
              });
            } else {
              existing.count++;
              // Keep the email with the best state (non-null over null)
              if (!existing.latest.threadState && email.threadState) {
                existing.latest = email;
              }
            }
          }

          // Get actual message counts per thread
          const threadIds = [...threadMap.keys()];
          const threadCounts = await db
            .select({
              gmailThreadId: emailsRaw.gmailThreadId,
              messageCount: sql<number>`count(*)::int`,
            })
            .from(emailsRaw)
            .where(
              and(
                eq(emailsRaw.userId, userId),
                inArray(emailsRaw.gmailThreadId, threadIds)
              )
            )
            .groupBy(emailsRaw.gmailThreadId);

          const threadCountMap = new Map<string, number>();
          for (const tc of threadCounts) {
            threadCountMap.set(tc.gmailThreadId, tc.messageCount);
          }

          const threads = [...threadMap.values()].map(({ latest: t }) => ({
            subject: t.subject || "(no subject)",
            from: t.fromName
              ? `${t.fromName} <${t.fromEmail}>`
              : t.fromEmail,
            thread_state: t.threadState || "unclassified",
            thread_state_reason: t.threadStateReason || "",
            direction: t.direction,
            message_count: threadCountMap.get(t.gmailThreadId) || 1,
            last_message: t.date
              ? formatDistanceToNow(t.date, { addSuffix: true })
              : "unknown",
          }));

          const awaitingYourReply = threads.filter(
            (t) => t.thread_state === "awaiting_your_reply",
          );
          const awaitingTheirReply = threads.filter(
            (t) => t.thread_state === "awaiting_their_reply",
          );
          const fyi = threads.filter((t) => t.thread_state === "fyi");
          const resolved = threads.filter(
            (t) => t.thread_state === "resolved",
          );
          const unclassified = threads.filter(
            (t) => t.thread_state === "unclassified",
          );

          let digestSummary = `📧 **Email Digest** (${threads.length} threads)\n`;
          if (awaitingYourReply.length > 0)
            digestSummary += `📩 **${awaitingYourReply.length} awaiting your reply**\n`;
          if (awaitingTheirReply.length > 0)
            digestSummary += `⏳ **${awaitingTheirReply.length} awaiting their reply**\n`;
          if (fyi.length > 0)
            digestSummary += `ℹ️ **${fyi.length} FYI**\n`;
          if (resolved.length > 0)
            digestSummary += `✅ **${resolved.length} resolved**\n`;
          if (unclassified.length > 0)
            digestSummary += `❓ **${unclassified.length} unclassified**\n`;

          if (awaitingYourReply.length > 0) {
            digestSummary += "\n**Needs your reply:**\n";
            awaitingYourReply.slice(0, 10).forEach((t) => {
              digestSummary += `📩 **${t.subject}** from ${t.from} • ${t.last_message}\n`;
            });
          }

          if (awaitingTheirReply.length > 0) {
            digestSummary += "\n**Waiting on others:**\n";
            awaitingTheirReply.slice(0, 5).forEach((t) => {
              digestSummary += `⏳ **${t.subject}** from ${t.from} • ${t.last_message}\n`;
            });
          }

          return {
            ok: true,
            message: digestSummary,
            stats: statsMap,
            threads,
            awaiting_reply_count: awaitingYourReply.length,
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

    update_email_thread: tool({
      description:
        "Update the triage state of an email thread. Use when a user tells you a thread is spam, resolved, not actionable, etc. Updates all emails in the thread. Any user can update their own threads.",
      inputSchema: z
        .object({
          user_name: z
            .string()
            .describe(
              "Display name, username, or user ID of the Gmail account owner",
            ),
          gmail_thread_id: z
            .string()
            .optional()
            .describe("Gmail thread ID to update"),
          subject_search: z
            .string()
            .optional()
            .describe(
              "Search by subject (partial match) if thread ID unknown",
            ),
          thread_state: z
            .enum(threadStateValues)
            .describe("New state"),
          reason: z
            .string()
            .optional()
            .describe("Why the state was changed"),
        })
        .refine((d) => d.gmail_thread_id || d.subject_search, {
          message: "Provide gmail_thread_id or subject_search",
        }),
      execute: async ({
        user_name,
        gmail_thread_id,
        subject_search,
        thread_state,
        reason,
      }) => {
        try {
          const user = await resolveUserByName(client, user_name);
          if (!user) {
            return {
              ok: false as const,
              error: `Could not resolve user '${user_name}'.`,
            };
          }

          if (user.id !== context?.userId && !isAdmin(context?.userId)) {
            return {
              ok: false as const,
              error:
                "You can only update your own email threads. Ask an admin to update other users' threads.",
            };
          }

          const userId = user.id;

          const conditions = [eq(emailsRaw.userId, userId)];
          if (gmail_thread_id) {
            conditions.push(eq(emailsRaw.gmailThreadId, gmail_thread_id));
          } else if (subject_search) {
            const escaped = subject_search.replace(/[\\%_]/g, "\\$&");
            conditions.push(ilike(emailsRaw.subject, `%${escaped}%`));
          }

          // Find distinct threads that match
          const matchingThreads = await db
            .selectDistinct({ gmailThreadId: emailsRaw.gmailThreadId, subject: emailsRaw.subject })
            .from(emailsRaw)
            .where(and(...conditions));

          if (matchingThreads.length === 0) {
            return {
              ok: false as const,
              error: gmail_thread_id
                ? `No emails found for thread ID '${gmail_thread_id}'.`
                : `No emails found matching subject '${subject_search}'.`,
            };
          }

          const threadIds = [
            ...new Set(matchingThreads.map((t) => t.gmailThreadId)),
          ];

          const result = await db
            .update(emailsRaw)
            .set({
              threadState: thread_state,
              threadStateReason: reason ?? null,
              threadStateUpdatedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(emailsRaw.userId, userId),
                inArray(emailsRaw.gmailThreadId, threadIds),
              ),
            )
            .returning({ gmailThreadId: emailsRaw.gmailThreadId });

          const subjects = [
            ...new Set(
              matchingThreads.map((t) => t.subject || "(no subject)"),
            ),
          ];

          logger.info("update_email_thread", {
            userId,
            threadIds,
            thread_state,
            updated: result.length,
          });

          return {
            ok: true as const,
            updated: result.length,
            threads: subjects,
            thread_state,
            message: `Updated ${result.length} email(s) across ${threadIds.length} thread(s) to '${thread_state}': ${subjects.join(", ")}`,
          };
        } catch (error: any) {
          logger.error("update_email_thread failed", {
            userName: user_name,
            error: error.message,
          });
          return {
            ok: false as const,
            error: `Update failed: ${error.message}`,
          };
        }
      },
    }),
  };
}

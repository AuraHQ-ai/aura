import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { eq, and, desc, sql, inArray, isNotNull } from "drizzle-orm";
import { formatDistanceToNow } from "date-fns";
import type { WebClient } from "@slack/web-api";
import { logger } from "../lib/logger.js";
import { isAdmin } from "../lib/permissions.js";
import { db } from "../db/client.js";
import { emailsRaw } from "../db/schema.js";
import type { ScheduleContext } from "../db/schema.js";
import { resolveUserByName } from "./slack.js";
import { threadStateValues } from "../lib/email-triage.js";
import { embedText } from "../lib/embeddings.js";

// ── Tool Definitions ────────────────────────────────────────────────────────

export function createEmailSyncTools(
  client: WebClient,
  context?: ScheduleContext,
) {
  return {
    sync_emails: defineTool({
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
      slack: { status: "Syncing emails...", detail: (i) => i.user_name },
    }),

    email_digest: defineTool({
      description:
        "Get an email digest for a user: returns structured data with counts and thread objects (each with gmail_thread_id). Use threads[].gmail_thread_id for follow-up actions. Admin-only.",
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
            gmail_thread_id: t.gmailThreadId,
            subject: t.subject || "(no subject)",
            from: t.fromName
              ? `${t.fromName} <${t.fromEmail}>`
              : t.fromEmail,
            from_email: t.fromEmail,
            thread_state: t.threadState || "unclassified",
            thread_state_reason: t.threadStateReason || "",
            direction: t.direction,
            email_count: threadCountMap.get(t.gmailThreadId) || 1,
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

          return {
            ok: true,
            counts: {
              awaiting_your_reply: awaitingYourReply.length,
              awaiting_their_reply: awaitingTheirReply.length,
              fyi: fyi.length,
              resolved: resolved.length,
              unclassified: unclassified.length,
              total: threads.length,
            },
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
      slack: { status: "Running email digest...", detail: (i) => i.user_name },
    }),

    update_email_thread: defineTool({
      description:
        "Update the triage state of an email thread by gmail_thread_id. Get the thread ID from email_digest or search_emails. Any user can update their own threads.",
      inputSchema: z
        .object({
          user_name: z
            .string()
            .describe(
              "Display name, username, or user ID of the Gmail account owner",
            ),
          gmail_thread_id: z
            .string()
            .describe("Gmail thread ID to update"),
          thread_state: z
            .enum(threadStateValues)
            .describe("New state"),
          reason: z
            .string()
            .optional()
            .describe("Why the state was changed"),
        }),
      execute: async ({
        user_name,
        gmail_thread_id,
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

          conditions.push(eq(emailsRaw.gmailThreadId, gmail_thread_id));

          // Find distinct threads that match
          const matchingThreads = await db
            .selectDistinct({ gmailThreadId: emailsRaw.gmailThreadId, subject: emailsRaw.subject })
            .from(emailsRaw)
            .where(and(...conditions));

          if (matchingThreads.length === 0) {
            return {
              ok: false as const,
              error: `No emails found for thread ID '${gmail_thread_id}'.`,
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
      slack: { status: "Updating email thread..." },
    }),

    update_email_threads: defineTool({
      description:
        "Batch-update triage states for multiple email threads at once. Accepts an array of {gmail_thread_id, thread_state, reason?}. Use after email_digest to dismiss/resolve/reclassify several threads in one call. Admin-only.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "Display name, username, or user ID of the Gmail account owner",
          ),
        updates: z
          .array(
            z.object({
              gmail_thread_id: z.string().describe("Gmail thread ID"),
              thread_state: z
                .enum(threadStateValues)
                .describe("New state for this thread"),
              reason: z
                .string()
                .optional()
                .describe("Why the state was changed"),
            }),
          )
          .min(1)
          .describe("Array of thread updates to apply"),
      }),
      execute: async ({ user_name, updates }) => {
        if (!isAdmin(context?.userId)) {
          return {
            ok: false as const,
            error: "This tool is restricted to admin users only.",
          };
        }

        try {
          const user = await resolveUserByName(client, user_name);
          if (!user) {
            return {
              ok: false as const,
              error: `Could not resolve user '${user_name}'.`,
            };
          }

          const userId = user.id;
          let totalUpdated = 0;
          let totalFailed = 0;
          const details: Array<{
            gmail_thread_id: string;
            status: "updated" | "failed" | "not_found";
            error?: string;
          }> = [];

          for (const update of updates) {
            try {
              const result = await db
                .update(emailsRaw)
                .set({
                  threadState: update.thread_state,
                  threadStateReason: update.reason ?? null,
                  threadStateUpdatedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(emailsRaw.userId, userId),
                    eq(emailsRaw.gmailThreadId, update.gmail_thread_id),
                  ),
                )
                .returning({ gmailThreadId: emailsRaw.gmailThreadId });

              if (result.length === 0) {
                totalFailed++;
                details.push({
                  gmail_thread_id: update.gmail_thread_id,
                  status: "not_found",
                  error: "No emails found for this thread ID",
                });
              } else {
                totalUpdated += result.length;
                details.push({
                  gmail_thread_id: update.gmail_thread_id,
                  status: "updated",
                });
              }
            } catch (err: any) {
              totalFailed++;
              details.push({
                gmail_thread_id: update.gmail_thread_id,
                status: "failed",
                error: err.message,
              });
            }
          }

          logger.info("update_email_threads batch", {
            userId,
            requested: updates.length,
            updated: totalUpdated,
            failed: totalFailed,
          });

          if (totalUpdated === 0 && totalFailed > 0) {
            return {
              ok: false as const,
              updated: totalUpdated,
              failed: totalFailed,
              details,
              message: `Batch update failed: all ${totalFailed} thread(s) failed to update.`,
            };
          }

          return {
            ok: true as const,
            updated: totalUpdated,
            failed: totalFailed,
            details,
            message: `Batch update: ${totalUpdated} email(s) updated across ${updates.length - totalFailed} thread(s), ${totalFailed} failed.`,
          };
        } catch (error: any) {
          logger.error("update_email_threads failed", {
            userName: user_name,
            error: error.message,
          });
          return {
            ok: false as const,
            error: `Batch update failed: ${error.message}`,
          };
        }
      },
      slack: { status: "Updating email threads..." },
    }),

    search_emails: defineTool({
      description:
        "Search synced emails by keyword (text mode) or meaning (semantic mode). Text mode uses PostgreSQL full-text search on subject + body. Semantic mode embeds the query and finds similar email threads via cosine similarity. Returns one result per thread (latest email). Admin-only.",
      inputSchema: z.object({
        user_name: z
          .string()
          .describe(
            "Display name, username, or user ID of the Gmail account owner",
          ),
        query: z.string().describe("Search query string"),
        mode: z
          .enum(["text", "semantic"])
          .default("text")
          .describe(
            "Search mode: 'text' for keyword/full-text search, 'semantic' for meaning-based vector search. Default 'text'.",
          ),
        thread_state: z
          .enum(threadStateValues)
          .optional()
          .describe("Optional filter by thread state"),
        limit: z
          .number()
          .min(1)
          .max(20)
          .default(10)
          .describe("Max results to return (default 10, max 20)"),
      }),
      execute: async ({ user_name, query, mode, thread_state, limit }) => {
        if (!isAdmin(context?.userId)) {
          return {
            ok: false as const,
            error: "This tool is restricted to admin users only.",
          };
        }

        try {
          const user = await resolveUserByName(client, user_name);
          if (!user) {
            return {
              ok: false as const,
              error: `Could not resolve user '${user_name}'.`,
            };
          }

          const userId = user.id;
          const conditions = [eq(emailsRaw.userId, userId)];

          if (thread_state) {
            conditions.push(eq(emailsRaw.threadState, thread_state));
          }

          let results: {
            gmailThreadId: string;
            subject: string | null;
            fromEmail: string;
            fromName: string | null;
            date: Date;
            threadState: string | null;
            bodyMarkdown: string | null;
            similarity?: number;
          }[];

          if (mode === "semantic") {
            const trimmedSemantic = query.trim();
            if (!trimmedSemantic) {
              return {
                ok: false as const,
                error: "Query is empty.",
              };
            }

            const queryEmbedding = await embedText(trimmedSemantic);
            const embeddingStr = `[${queryEmbedding.join(",")}]`;

            conditions.push(isNotNull(emailsRaw.embedding));

            const distExpr = sql`${emailsRaw.embedding} <=> ${embeddingStr}::vector`;

            const deduped = db
              .selectDistinctOn([emailsRaw.gmailThreadId], {
                gmailThreadId: emailsRaw.gmailThreadId,
                subject: emailsRaw.subject,
                fromEmail: emailsRaw.fromEmail,
                fromName: emailsRaw.fromName,
                date: emailsRaw.date,
                threadState: emailsRaw.threadState,
                bodyMarkdown: emailsRaw.bodyMarkdown,
                dist: distExpr.as("dist"),
              })
              .from(emailsRaw)
              .where(and(...conditions))
              .orderBy(emailsRaw.gmailThreadId, distExpr)
              .as("deduped");

            const rawResults = await db
              .select({
                gmailThreadId: deduped.gmailThreadId,
                subject: deduped.subject,
                fromEmail: deduped.fromEmail,
                fromName: deduped.fromName,
                date: deduped.date,
                threadState: deduped.threadState,
                bodyMarkdown: deduped.bodyMarkdown,
                similarity: sql<number>`1 - ${deduped.dist}`,
              })
              .from(deduped)
              .orderBy(sql`${deduped.dist}`)
              .limit(limit);

            results = rawResults;
          } else {
            const trimmed = query.trim();

            if (!trimmed) {
              return {
                ok: false as const,
                error: "Query is empty.",
              };
            }

            const rawResults = await db
              .select({
                gmailThreadId: emailsRaw.gmailThreadId,
                subject: emailsRaw.subject,
                fromEmail: emailsRaw.fromEmail,
                fromName: emailsRaw.fromName,
                date: emailsRaw.date,
                threadState: emailsRaw.threadState,
                bodyMarkdown: emailsRaw.bodyMarkdown,
                rank: sql<number>`ts_rank(
                  to_tsvector('english', coalesce(${emailsRaw.subject}, '') || ' ' || coalesce(${emailsRaw.bodyMarkdown}, '')),
                  websearch_to_tsquery('english', ${trimmed})
                )`,
              })
              .from(emailsRaw)
              .where(
                and(
                  ...conditions,
                  sql`to_tsvector('english', coalesce(${emailsRaw.subject}, '') || ' ' || coalesce(${emailsRaw.bodyMarkdown}, '')) @@ websearch_to_tsquery('english', ${trimmed})`,
                ),
              )
              .orderBy(
                desc(
                  sql`ts_rank(
                    to_tsvector('english', coalesce(${emailsRaw.subject}, '') || ' ' || coalesce(${emailsRaw.bodyMarkdown}, '')),
                    websearch_to_tsquery('english', ${trimmed})
                  )`,
                ),
              )
              .limit(limit * 3);

            const threadMap = new Map<
              string,
              (typeof rawResults)[0]
            >();
            for (const row of rawResults) {
              const existing = threadMap.get(row.gmailThreadId);
              if (!existing) {
                threadMap.set(row.gmailThreadId, row);
              } else {
                const bestRank = Math.max(row.rank ?? 0, existing.rank ?? 0);
                if (row.date.getTime() > existing.date.getTime()) {
                  threadMap.set(row.gmailThreadId, { ...row, rank: bestRank });
                } else {
                  existing.rank = bestRank;
                }
              }
            }

            results = [...threadMap.values()]
              .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
              .slice(0, limit);
          }

          const formatted = results.map((r) => ({
            gmail_thread_id: r.gmailThreadId,
            subject: r.subject || "(no subject)",
            from_email: r.fromEmail,
            from_name: r.fromName || "",
            date: r.date.toISOString(),
            thread_state: r.threadState || "unclassified",
            snippet: (r.bodyMarkdown || "").slice(0, 200),
            ...(mode === "semantic" && r.similarity != null
              ? { similarity: Math.round(r.similarity * 1000) / 1000 }
              : {}),
          }));

          return {
            ok: true as const,
            mode,
            count: formatted.length,
            results: formatted,
            message: `Found ${formatted.length} thread(s) matching "${query}" (${mode} search)`,
          };
        } catch (error: any) {
          logger.error("search_emails tool failed", {
            userName: user_name,
            query,
            mode,
            error: error.message,
          });
          return {
            ok: false as const,
            error: `Search failed: ${error.message}`,
          };
        }
      },
      slack: { status: "Searching emails...", detail: (i) => i.query },
    }),
  };
}

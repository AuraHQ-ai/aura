import { tool } from "ai";
import { z } from "zod";
import { sql, and, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import { messages } from "../db/schema.js";
import { logger } from "../lib/logger.js";

const MAX_CONTENT_LENGTH = 500;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

interface MessageRow {
  id: string;
  slack_ts: string;
  slack_thread_ts: string | null;
  channel_id: string;
  channel_type: string;
  user_id: string;
  role: string;
  content: string;
  created_at: Date | string;
}

export interface ThreadGroup {
  thread_ts: string | null;
  channel_id: string;
  messages: Array<{
    id: string;
    user_id: string;
    role: string;
    content: string;
    timestamp: string;
    channel_id: string;
    channel_type: string;
  }>;
}

export function createConversationSearchTools() {
  return {
    search_my_conversations: tool({
      description:
        "Search Aura's stored messages database (every message she has sent and received). Use this to recall past conversations, find what was discussed about a topic, or look up what a specific person said. Supports text search with optional filters by user, channel, time range, and message role. Results are grouped by conversation thread.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "Search term or phrase. Uses PostgreSQL full-text search with fallback to case-insensitive substring match. Omit to browse with filters only.",
          ),
        user_id: z
          .string()
          .optional()
          .describe("Filter by Slack user ID (e.g. 'U066V1AN6')"),
        channel_id: z
          .string()
          .optional()
          .describe("Filter by Slack channel ID (e.g. 'C0BNVKS77')"),
        since: z
          .string()
          .optional()
          .describe(
            "Only messages after this ISO 8601 date/time, e.g. '2025-01-15' or '2025-01-15T09:00:00Z'",
          ),
        until: z
          .string()
          .optional()
          .describe(
            "Only messages before this ISO 8601 date/time, e.g. '2025-01-20' or '2025-01-20T18:00:00Z'",
          ),
        role: z
          .enum(["user", "assistant"])
          .optional()
          .describe("Filter by message role: 'user' or 'assistant'"),
        limit: z
          .number()
          .min(1)
          .max(MAX_LIMIT)
          .default(DEFAULT_LIMIT)
          .describe(`Max messages to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
        offset: z
          .number()
          .min(0)
          .default(0)
          .describe("Number of messages to skip for pagination (default 0)"),
      }),
      execute: async ({ query, user_id, channel_id, since, until, role, limit, offset }) => {
        try {
          if (!query && !user_id && !channel_id && !since && !until && !role) {
            return {
              ok: false,
              error:
                "Provide at least one of: query, user_id, channel_id, since, until, or role.",
            };
          }

          const conditions: ReturnType<typeof eq>[] = [];

          if (user_id) {
            conditions.push(eq(messages.userId, user_id));
          }
          if (channel_id) {
            conditions.push(eq(messages.channelId, channel_id));
          }
          if (role) {
            conditions.push(eq(messages.role, role));
          }
          if (since) {
            const sinceDate = new Date(since);
            if (isNaN(sinceDate.getTime())) {
              return { ok: false, error: `Invalid 'since' date: "${since}"` };
            }
            conditions.push(gte(messages.createdAt, sinceDate));
          }
          if (until) {
            const untilDate = new Date(until);
            if (isNaN(untilDate.getTime())) {
              return { ok: false, error: `Invalid 'until' date: "${until}"` };
            }
            conditions.push(lte(messages.createdAt, untilDate));
          }

          let rows: MessageRow[];

          if (query) {
            const trimmed = query.trim();
            if (!trimmed) {
              return { ok: false, error: "Query cannot be empty string." };
            }

            try {
              // PostgreSQL full-text search
              const tsCondition = sql`to_tsvector('english', ${messages.content}) @@ websearch_to_tsquery('english', ${trimmed})`;
              const allConditions =
                conditions.length > 0
                  ? and(tsCondition, ...conditions)
                  : tsCondition;

              const results = await db.execute(sql`
                SELECT id, slack_ts, slack_thread_ts, channel_id, channel_type,
                       user_id, role, content, created_at,
                       ts_rank(to_tsvector('english', content),
                               websearch_to_tsquery('english', ${trimmed})) as rank
                FROM messages
                WHERE ${allConditions}
                ORDER BY rank DESC, created_at DESC
                LIMIT ${limit}
                OFFSET ${offset}
              `);
              rows = ((results as any).rows ?? results) as MessageRow[];
            } catch {
              // Fallback: ILIKE substring search
              const escaped = trimmed.replace(/[\\%_]/g, "\\$&");
              const pattern = `%${escaped}%`;
              const ilikeCondition = sql`${messages.content} ILIKE ${pattern}`;
              const allConditions =
                conditions.length > 0
                  ? and(ilikeCondition, ...conditions)
                  : ilikeCondition;

              const results = await db.execute(sql`
                SELECT id, slack_ts, slack_thread_ts, channel_id, channel_type,
                       user_id, role, content, created_at
                FROM messages
                WHERE ${allConditions}
                ORDER BY created_at DESC
                LIMIT ${limit}
                OFFSET ${offset}
              `);
              rows = ((results as any).rows ?? results) as MessageRow[];
            }
          } else {
            // No text query — filter-only browse
            const allConditions =
              conditions.length > 0 ? and(...conditions) : sql`true`;

            const results = await db.execute(sql`
              SELECT id, slack_ts, slack_thread_ts, channel_id, channel_type,
                     user_id, role, content, created_at
              FROM messages
              WHERE ${allConditions}
              ORDER BY created_at DESC
              LIMIT ${limit}
              OFFSET ${offset}
            `);
            rows = ((results as any).rows ?? results) as MessageRow[];
          }

          // Group by thread
          const threadMap = new Map<string, ThreadGroup>();
          for (const row of rows) {
            const threadKey = row.slack_thread_ts || row.slack_ts;
            let group = threadMap.get(threadKey);
            if (!group) {
              group = {
                thread_ts: row.slack_thread_ts || row.slack_ts,
                channel_id: row.channel_id,
                messages: [],
              };
              threadMap.set(threadKey, group);
            }
            group.messages.push({
              id: row.id,
              user_id: row.user_id,
              role: row.role,
              content: truncate(row.content, MAX_CONTENT_LENGTH),
              timestamp: typeof row.created_at === "string"
                ? row.created_at
                : new Date(row.created_at).toISOString(),
              channel_id: row.channel_id,
              channel_type: row.channel_type,
            });
          }

          // Sort messages within each thread by timestamp
          for (const group of threadMap.values()) {
            group.messages.sort(
              (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
            );
          }

          const threads = Array.from(threadMap.values());

          // Fetch thread context: for each thread, get surrounding messages
          const threadContexts: ThreadGroup[] = [];
          if (threads.length > 0 && threads.length <= 10) {
            for (const thread of threads) {
              const threadKey =
                thread.thread_ts || thread.messages[0]?.timestamp;
              if (!threadKey) {
                threadContexts.push(thread);
                continue;
              }

              try {
                const contextResults = await db.execute(sql`
                  SELECT id, slack_ts, slack_thread_ts, channel_id, channel_type,
                         user_id, role, content, created_at
                  FROM messages
                  WHERE (slack_thread_ts = ${threadKey} OR slack_ts = ${threadKey})
                    AND channel_id = ${thread.channel_id}
                  ORDER BY created_at ASC
                  LIMIT 20
                `);
                const contextRows = (
                  (contextResults as any).rows ?? contextResults
                ) as MessageRow[];

                const matchIds = new Set(thread.messages.map((m) => m.id));
                const contextIds = new Set(contextRows.map((r) => r.id));
                const contextMessages = contextRows.map((r) => ({
                  id: r.id,
                  user_id: r.user_id,
                  role: r.role,
                  content: truncate(r.content, MAX_CONTENT_LENGTH),
                  timestamp:
                    typeof r.created_at === "string"
                      ? r.created_at
                      : new Date(r.created_at).toISOString(),
                  channel_id: r.channel_id,
                  channel_type: r.channel_type,
                  ...(matchIds.has(r.id) ? { matched: true } : {}),
                }));
                const missingMatches = thread.messages
                  .filter((m) => !contextIds.has(m.id))
                  .map((m) => ({ ...m, matched: true }));
                const allMessages = [...contextMessages, ...missingMatches].sort(
                  (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
                );
                const fullThread: ThreadGroup = {
                  thread_ts: thread.thread_ts,
                  channel_id: thread.channel_id,
                  messages: allMessages as ThreadGroup["messages"],
                };
                threadContexts.push(fullThread);
              } catch {
                threadContexts.push(thread);
              }
            }
          } else {
            threadContexts.push(...threads);
          }

          logger.info("search_my_conversations tool called", {
            query: query?.substring(0, 100),
            user_id,
            channel_id,
            since,
            until,
            role,
            resultCount: rows.length,
            threadCount: threadContexts.length,
          });

          return {
            ok: true,
            query: query || null,
            filters: {
              ...(user_id ? { user_id } : {}),
              ...(channel_id ? { channel_id } : {}),
              ...(since ? { since } : {}),
              ...(until ? { until } : {}),
              ...(role ? { role } : {}),
            },
            threads: threadContexts,
            message_count: rows.length,
            thread_count: threadContexts.length,
            offset,
            has_more: rows.length === limit,
          };
        } catch (error: any) {
          logger.error("search_my_conversations tool failed", {
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to search conversations: ${error.message}`,
          };
        }
      },
    }),
  };
}

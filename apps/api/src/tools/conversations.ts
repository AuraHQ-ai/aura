import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { sql, and, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import { messages } from "@aura/db/schema";
import type { ScheduleContext } from "@aura/db/schema";
import { embedText } from "../lib/embeddings.js";
import { logger } from "../lib/logger.js";
import { formatTimestamp } from "../lib/temporal.js";

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
  similarity?: number;
}

export interface ThreadGroup {
  thread_ts: string | null;
  thread_started_at: string;
  channel_id: string;
  messages: Array<{
    id: string;
    user_id: string;
    role: string;
    content: string;
    timestamp: string;
    channel_id: string;
    channel_type: string;
    similarity_score?: number;
  }>;
}

export function createConversationSearchTools(context?: ScheduleContext) {
  return {
    search_my_conversations: defineTool({
      description:
        "Search Aura's stored messages database (every message she has sent and received is saved in PostgreSQL). Use this to recall past conversations, find what was discussed about a topic, or look up what a specific person said. Supports two modes: 'text' (keyword/full-text, default) and 'semantic' (vector similarity — better for conceptual queries). Results are grouped by conversation thread with surrounding context. Prefer this over search_messages for DM threads and conversations Aura has been part of — it searches Aura's own database, not Slack's search index, so has better coverage of her conversations. Use offset for pagination.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "Search term or phrase. In 'text' mode: uses PostgreSQL full-text search with fallback to case-insensitive substring match; omit to browse with filters only. In 'semantic' mode: required — the text is embedded and compared against stored message embeddings for meaning-based search.",
          ),
        mode: z
          .enum(["text", "semantic"])
          .default("text")
          .describe(
            "Search mode. 'text' (default): keyword-based full-text search. 'semantic': vector similarity search using embeddings — finds messages with similar meaning even if they don't share exact words.",
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
      execute: async ({ query, mode, user_id, channel_id, since, until, role, limit, offset }) => {
        try {
          if (mode === "semantic" && !query?.trim()) {
            return {
              ok: false,
              error: "The 'query' parameter is required when mode is 'semantic'.",
            };
          }

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

          if (mode === "semantic") {
            const trimmed = query!.trim();
            const queryEmbedding = await embedText(trimmed);
            const embeddingLiteral = JSON.stringify(queryEmbedding);

            const embeddingNotNull = sql`${messages.embedding} IS NOT NULL`;
            const allConditions =
              conditions.length > 0
                ? and(embeddingNotNull, ...conditions)
                : embeddingNotNull;

            const results = await db.execute(sql`
              SELECT id, slack_ts, slack_thread_ts, channel_id, channel_type,
                     user_id, role, content, created_at,
                     1 - (embedding <=> ${embeddingLiteral}::vector) as similarity
              FROM messages
              WHERE ${allConditions}
              ORDER BY embedding <=> ${embeddingLiteral}::vector
              LIMIT ${limit}
              OFFSET ${offset}
            `);
            rows = ((results as any).rows ?? results) as MessageRow[];
          } else if (query) {
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
          const messageDateMap = new Map<string, number>();
          for (const row of rows) {
            const threadKey = row.slack_thread_ts || row.slack_ts;
            let group = threadMap.get(threadKey);
            if (!group) {
              group = {
                thread_ts: row.slack_thread_ts || row.slack_ts,
                thread_started_at: formatTimestamp(row.slack_thread_ts || row.slack_ts, context?.timezone),
                channel_id: row.channel_id,
                messages: [],
              };
              threadMap.set(threadKey, group);
            }
            const createdDate = new Date(row.created_at);
            messageDateMap.set(row.id, createdDate.getTime());
            group.messages.push({
              id: row.id,
              user_id: row.user_id,
              role: row.role,
              content: truncate(row.content, MAX_CONTENT_LENGTH),
              timestamp: formatTimestamp(createdDate, context?.timezone),
              channel_id: row.channel_id,
              channel_type: row.channel_type,
              ...(row.similarity != null ? { similarity_score: Number(row.similarity) } : {}),
            });
          }

          // Sort messages within each thread by timestamp
          for (const group of threadMap.values()) {
            group.messages.sort(
              (a, b) => (messageDateMap.get(a.id) ?? 0) - (messageDateMap.get(b.id) ?? 0),
            );
          }

          const threads = Array.from(threadMap.values());

          // Fetch thread context: for each thread, get surrounding messages
          const threadContexts: ThreadGroup[] = [];
          if (threads.length > 0 && threads.length <= 10) {
            for (const [threadKey, thread] of threadMap.entries()) {
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
                const matchScoreMap = new Map(
                  thread.messages
                    .filter((m) => m.similarity_score != null)
                    .map((m) => [m.id, m.similarity_score!]),
                );
                const contextIds = new Set(contextRows.map((r) => r.id));
                const contextMessages = contextRows.map((r) => {
                  const ctxDate = new Date(r.created_at);
                  messageDateMap.set(r.id, ctxDate.getTime());
                  return {
                    id: r.id,
                    user_id: r.user_id,
                    role: r.role,
                    content: truncate(r.content, MAX_CONTENT_LENGTH),
                    timestamp: formatTimestamp(ctxDate, context?.timezone),
                    channel_id: r.channel_id,
                    channel_type: r.channel_type,
                    ...(matchIds.has(r.id)
                      ? {
                          matched: true,
                          ...(matchScoreMap.has(r.id)
                            ? { similarity_score: matchScoreMap.get(r.id) }
                            : {}),
                        }
                      : {}),
                  };
                });
                const missingMatches = thread.messages
                  .filter((m) => !contextIds.has(m.id))
                  .map((m) => ({ ...m, matched: true }));
                const allMessages = [...contextMessages, ...missingMatches].sort(
                  (a, b) => (messageDateMap.get(a.id) ?? 0) - (messageDateMap.get(b.id) ?? 0),
                );
                const fullThread: ThreadGroup = {
                  thread_ts: thread.thread_ts,
                  thread_started_at: thread.thread_started_at,
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
            mode,
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
            mode,
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
      slack: {
        status: "Searching conversations...",
        detail: (i) => i.query,
      },
    }),
  };
}

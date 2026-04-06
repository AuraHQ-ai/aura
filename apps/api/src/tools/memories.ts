import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { eq, and, sql, gte, lte, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories } from "@aura/db/schema";
import type { ScheduleContext } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { embedText } from "../lib/embeddings.js";

export function createMemoryTools(context?: ScheduleContext) {
  return {
    get_memory: defineTool({
      description:
        "Retrieve full details of a single memory by its UUID. Returns all fields including content, type, status, confidence, lifecycle metadata (supersedes/superseded_by), and related user IDs. Use this after search_memories to inspect a specific result.",
      inputSchema: z.object({
        id: z.string().uuid().describe("UUID of the memory to retrieve"),
      }),
      execute: async ({ id }) => {
        try {
          const rows = await db
            .select()
            .from(memories)
            .where(eq(memories.id, id))
            .limit(1);

          const memory = rows[0];
          if (!memory) {
            return { ok: false as const, error: `No memory found with id "${id}".` };
          }

          logger.info("get_memory tool called", { id });

          return {
            ok: true as const,
            memory: {
              id: memory.id,
              content: memory.content,
              type: memory.type,
              status: memory.status,
              confidence: memory.confidence,
              relevance_score: memory.relevanceScore,
              importance: memory.importance,
              related_user_ids: memory.relatedUserIds,
              source_channel_type: memory.sourceChannelType,
              supersedes_memory_id: memory.supersedesMemoryId,
              superseded_by_memory_id: memory.supersededByMemoryId,
              superseded_at: memory.supersededAt?.toISOString() ?? null,
              valid_from: memory.validFrom?.toISOString() ?? null,
              valid_until: memory.validUntil?.toISOString() ?? null,
              created_at: memory.createdAt.toISOString(),
              updated_at: memory.updatedAt.toISOString(),
            },
          };
        } catch (error: any) {
          logger.error("get_memory tool failed", { id, error: error.message });
          return { ok: false as const, error: `Failed to get memory: ${error.message}` };
        }
      },
      slack: {
        status: "Retrieving memory...",
        detail: (i) => i.id.substring(0, 8),
        output: (r) => r.ok === false ? r.error : `Memory ${r.memory.id.substring(0, 8)}`,
      },
    }),

    delete_memory: defineTool({
      description:
        "Delete a memory by its UUID. Verifies the memory exists before deleting and returns a preview of the deleted content (first 100 chars). Use this to remove stale, incorrect, or duplicate memories.",
      inputSchema: z.object({
        id: z.string().uuid().describe("UUID of the memory to delete"),
      }),
      execute: async ({ id }) => {
        try {
          const rows = await db
            .select({ id: memories.id, content: memories.content })
            .from(memories)
            .where(eq(memories.id, id))
            .limit(1);

          const memory = rows[0];
          if (!memory) {
            return { ok: false as const, error: `No memory found with id "${id}".` };
          }

          await db.delete(memories).where(eq(memories.id, id));

          const preview = memory.content.substring(0, 100) + (memory.content.length > 100 ? "..." : "");

          logger.info("delete_memory tool called", { id });

          return {
            ok: true as const,
            message: `Memory "${id}" deleted.`,
            deleted_content_preview: preview,
          };
        } catch (error: any) {
          logger.error("delete_memory tool failed", { id, error: error.message });
          return { ok: false as const, error: `Failed to delete memory: ${error.message}` };
        }
      },
      slack: {
        status: "Deleting memory...",
        detail: (i) => i.id.substring(0, 8),
        output: (r) => r.ok === false ? r.error : "Memory deleted",
      },
    }),

    search_memories: defineTool({
      description:
        "Search memories with flexible filters. Supports two modes: 'text' (default, full-text keyword search on content) and 'semantic' (vector similarity for conceptual matches). Can filter by type (fact, decision, preference, event, open_thread), status (current, superseded, disputed, archived, deleted — defaults to 'current'), date range, and related user. Use this to find specific memories before updating or deleting them.",
      inputSchema: z.object({
        query: z.string().optional().describe("Text to search across memory content"),
        type: z
          .enum(["fact", "decision", "preference", "event", "open_thread"])
          .optional()
          .describe("Filter by memory type"),
        status: z
          .enum(["current", "superseded", "disputed", "archived", "deleted"])
          .optional()
          .default("current")
          .describe("Filter by status. Default: 'current'"),
        since: z.string().optional().describe("ISO 8601 date — only memories created after this date"),
        until: z.string().optional().describe("ISO 8601 date — only memories created before this date"),
        user_id: z.string().optional().describe("Filter by related user ID (Slack user ID)"),
        limit: z.number().int().min(1).max(50).optional().default(20).describe("Max results (default 20, max 50)"),
        mode: z
          .enum(["text", "semantic"])
          .optional()
          .default("text")
          .describe("'text' for full-text keyword search, 'semantic' for vector similarity"),
      }),
      execute: async ({ query, type, status, since, until, user_id, limit, mode }) => {
        try {
          if (mode === "semantic") {
            if (!query?.trim()) {
              return { ok: false as const, error: "Query is required for semantic search mode." };
            }

            const queryEmbedding = await embedText(query.trim());
            const vectorSql = sql.raw(`'[${queryEmbedding.join(",")}]'::vector`);

            const conditions = [isNotNull(memories.embedding)];
            if (status) conditions.push(eq(memories.status, status));
            if (type) conditions.push(eq(memories.type, type));
            if (since) conditions.push(gte(memories.createdAt, new Date(since)));
            if (until) conditions.push(lte(memories.createdAt, new Date(until)));
            if (user_id) conditions.push(sql`${memories.relatedUserIds} @> ARRAY[${user_id}]::text[]`);

            const results = await db
              .select({
                id: memories.id,
                content: memories.content,
                type: memories.type,
                status: memories.status,
                createdAt: memories.createdAt,
                similarity: sql<number>`1 - (${memories.embedding} <=> ${vectorSql})`.as("similarity"),
              })
              .from(memories)
              .where(and(...conditions))
              .orderBy(sql`${memories.embedding} <=> ${vectorSql}`)
              .limit(limit);

            logger.info("search_memories tool called (semantic)", {
              query: query.trim().substring(0, 100),
              resultCount: results.length,
            });

            return {
              ok: true as const,
              mode: "semantic" as const,
              results: results.map((r) => ({
                id: r.id,
                content: r.content.substring(0, 200) + (r.content.length > 200 ? "..." : ""),
                type: r.type,
                status: r.status,
                created_at: r.createdAt.toISOString(),
                relevance_score: Math.round(r.similarity * 1000) / 1000,
              })),
              count: results.length,
            };
          }

          // text mode (default)
          const conditions: ReturnType<typeof eq>[] = [];
          if (status) conditions.push(eq(memories.status, status));
          if (type) conditions.push(eq(memories.type, type));
          if (since) conditions.push(gte(memories.createdAt, new Date(since)));
          if (until) conditions.push(lte(memories.createdAt, new Date(until)));
          if (user_id) conditions.push(sql`${memories.relatedUserIds} @> ARRAY[${user_id}]::text[]` as any);

          if (query?.trim()) {
            const trimmed = query.trim();

            const statusFilter = status ? sql`AND status = ${status}` : sql``;
            const typeFilter = type ? sql`AND type = ${type}` : sql``;
            const sinceFilter = since ? sql`AND created_at >= ${new Date(since)}` : sql``;
            const untilFilter = until ? sql`AND created_at <= ${new Date(until)}` : sql``;
            const userFilter = user_id ? sql`AND related_user_ids @> ARRAY[${user_id}]::text[]` : sql``;

            let rows: any[];
            try {
              const results = await db.execute(sql`
                SELECT id, content, type, status, created_at,
                  ts_rank(
                    to_tsvector('english', content),
                    websearch_to_tsquery('english', ${trimmed})
                  ) as rank
                FROM memories
                WHERE to_tsvector('english', content)
                  @@ websearch_to_tsquery('english', ${trimmed})
                  ${statusFilter}
                  ${typeFilter}
                  ${sinceFilter}
                  ${untilFilter}
                  ${userFilter}
                ORDER BY rank DESC
                LIMIT ${limit}
              `);
              rows = (results as any).rows ?? results;
            } catch {
              const escaped = trimmed.replace(/[\\%_]/g, "\\$&");
              const pattern = `%${escaped.toLowerCase()}%`;
              const results = await db.execute(sql`
                SELECT id, content, type, status, created_at
                FROM memories
                WHERE lower(content) LIKE ${pattern} ESCAPE '\\'
                  ${statusFilter}
                  ${typeFilter}
                  ${sinceFilter}
                  ${untilFilter}
                  ${userFilter}
                ORDER BY created_at DESC
                LIMIT ${limit}
              `);
              rows = (results as any).rows ?? results;
            }

            logger.info("search_memories tool called (text)", {
              query: trimmed.substring(0, 100),
              resultCount: rows.length,
            });

            return {
              ok: true as const,
              mode: "text" as const,
              results: rows.map((r: any) => ({
                id: r.id,
                content: (r.content as string).substring(0, 200) + ((r.content as string).length > 200 ? "..." : ""),
                type: r.type,
                status: r.status,
                created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
                relevance_score: r.rank != null ? Math.round(Number(r.rank) * 1000) / 1000 : null,
              })),
              count: rows.length,
            };
          }

          // No query — filter-only mode
          const results = await db
            .select({
              id: memories.id,
              content: memories.content,
              type: memories.type,
              status: memories.status,
              createdAt: memories.createdAt,
            })
            .from(memories)
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .orderBy(sql`${memories.createdAt} DESC`)
            .limit(limit);

          logger.info("search_memories tool called (filter)", {
            type,
            status,
            resultCount: results.length,
          });

          return {
            ok: true as const,
            mode: "filter" as const,
            results: results.map((r) => ({
              id: r.id,
              content: r.content.substring(0, 200) + (r.content.length > 200 ? "..." : ""),
              type: r.type,
              status: r.status,
              created_at: r.createdAt.toISOString(),
              relevance_score: null,
            })),
            count: results.length,
          };
        } catch (error: any) {
          logger.error("search_memories tool failed", { error: error.message });
          return { ok: false as const, error: `Failed to search memories: ${error.message}` };
        }
      },
      slack: {
        status: "Searching memories...",
        detail: (i) => i.query ?? i.type ?? i.status ?? undefined,
        output: (r) => r.ok === false ? r.error : `${r.count} results`,
      },
    }),

    update_memory: defineTool({
      description:
        "Update a memory's content, status, or confidence. If content changes, the embedding is automatically re-computed. Use this to correct inaccurate memories, change their status (e.g. mark as 'archived' or 'superseded'), or adjust confidence scores.",
      inputSchema: z.object({
        id: z.string().uuid().describe("UUID of the memory to update"),
        content: z.string().optional().describe("New content text. Triggers re-embedding if changed."),
        status: z
          .enum(["current", "superseded", "disputed", "archived", "deleted"])
          .optional()
          .describe("New status for the memory"),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("New confidence score (0–1)"),
      }),
      execute: async ({ id, content, status, confidence }) => {
        try {
          if (content === undefined && status === undefined && confidence === undefined) {
            return { ok: false as const, error: "At least one of content, status, or confidence must be provided." };
          }

          const rows = await db
            .select({ id: memories.id })
            .from(memories)
            .where(eq(memories.id, id))
            .limit(1);

          if (rows.length === 0) {
            return { ok: false as const, error: `No memory found with id "${id}".` };
          }

          const updates: Record<string, unknown> = { updatedAt: new Date() };
          const updatedFields: string[] = [];

          if (content !== undefined) {
            updates.content = content;
            const newEmbedding = await embedText(content);
            updates.embedding = newEmbedding;
            updatedFields.push("content");
          }

          if (status !== undefined) {
            updates.status = status;
            updatedFields.push("status");
          }

          if (confidence !== undefined) {
            updates.confidence = confidence;
            updatedFields.push("confidence");
          }

          await db.update(memories).set(updates).where(eq(memories.id, id));

          logger.info("update_memory tool called", { id, updatedFields });

          return {
            ok: true as const,
            message: `Memory "${id}" updated. Changed: ${updatedFields.join(", ")}.`,
            updated_fields: updatedFields,
          };
        } catch (error: any) {
          logger.error("update_memory tool failed", { id, error: error.message });
          return { ok: false as const, error: `Failed to update memory: ${error.message}` };
        }
      },
      slack: {
        status: "Updating memory...",
        detail: (i) => i.id.substring(0, 8),
        output: (r) => r.ok === false ? r.error : "Memory updated",
      },
    }),
  };
}

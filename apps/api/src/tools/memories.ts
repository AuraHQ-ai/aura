import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { eq, and, sql, gte, lte, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { memories } from "@aura/db/schema";
import type { ScheduleContext } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { embedText } from "../lib/embeddings.js";
import { resolveEntityByName, searchEntities } from "../memory/entity-resolution.js";

const DEFAULT_WORKSPACE_ID = process.env.DEFAULT_WORKSPACE_ID || "default";

export function createMemoryTools(context?: ScheduleContext) {
  return {
    get_memory: defineTool({
      description:
        "Retrieve full details of a single memory by its UUID. Returns all fields including content, type, status, confidence, lifecycle metadata (supersedes/superseded_by), source provenance (thread_ts, channel_id), and related user IDs. Use this after search_memories to inspect a specific result.",
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
              source_thread_ts: memory.sourceThreadTs ?? null,
              source_channel_id: memory.sourceChannelId ?? null,
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
        "Permanently delete a memory by its UUID. Use this to remove incorrect, duplicate, or harmful memories. Irreversible — double-check with get_memory first if unsure.",
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

          if (rows.length === 0) {
            return { ok: false as const, error: `No memory found with id "${id}".` };
          }

          await db.delete(memories).where(eq(memories.id, id));

          logger.info("delete_memory tool called", { id, contentPreview: rows[0].content.substring(0, 80) });

          return {
            ok: true as const,
            message: `Memory "${id}" deleted.`,
            deleted_content_preview: rows[0].content.substring(0, 100),
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
        "Search memories with flexible filters. Supports two modes: 'text' (default, full-text keyword search on content) and 'semantic' (vector similarity for conceptual matches). Can filter by type (fact, decision, preference, event, open_thread), status (current, superseded, disputed, archived, deleted — defaults to 'current'), date range, related user, and entity name. Entity search uses the same resolution cascade as the context builder (exact canonical → alias → trigram fuzzy). Use this to find specific memories before updating or deleting them.",
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
        entity: z.string().optional().describe("Filter by entity name (person, company, product, etc.). Resolves via alias/fuzzy matching — same cascade as the context builder."),
        entity_type: z
          .enum(["person", "company", "channel", "technology", "product", "project"])
          .optional()
          .describe("Narrow entity resolution to a specific type. Optional — omit to match across all types."),
        limit: z.number().int().min(1).max(50).optional().default(20).describe("Max results (default 20, max 50)"),
        mode: z
          .enum(["text", "semantic"])
          .optional()
          .default("text")
          .describe("'text' for full-text keyword search, 'semantic' for vector similarity"),
      }),
      execute: async ({ query, type, status, since, until, user_id, entity, entity_type, limit, mode }) => {
        try {
          // Resolve entity filter if provided
          let entityId: string | null = null;
          let resolvedEntityName: string | null = null;
          if (entity) {
            if (entity_type) {
              // Use type-aware resolution from resolveEntityReadOnly (imported indirectly)
              // But resolveEntityByName is type-agnostic. For typed resolution, call the DB directly.
              const { resolveEntityReadOnly } = await import("../memory/entity-resolution.js");
              const resolved = await resolveEntityReadOnly(entity, entity_type, DEFAULT_WORKSPACE_ID);
              if (resolved) {
                entityId = resolved.entityId;
                resolvedEntityName = resolved.canonicalName;
              }
            } else {
              const resolved = await resolveEntityByName(entity, DEFAULT_WORKSPACE_ID);
              if (resolved) {
                entityId = resolved.entityId;
                resolvedEntityName = resolved.canonicalName;
              }
            }

            if (!entityId) {
              return {
                ok: true as const,
                mode: "entity_not_found" as const,
                results: [],
                count: 0,
                message: `No entity found matching "${entity}"${entity_type ? ` (type: ${entity_type})` : ""}. Try search_entities to browse available entities.`,
              };
            }
          }

          // Build entity join clause
          const entityJoin = entityId
            ? sql`JOIN memory_entities me ON me.memory_id = m.id AND me.entity_id = ${entityId}`
            : sql``;

          if (mode === "semantic") {
            if (!query?.trim()) {
              return { ok: false as const, error: "Query is required for semantic search mode." };
            }

            const queryEmbedding = await embedText(query.trim());
            const vectorSql = sql.raw(`'[${queryEmbedding.join(",")}]'::vector`);

            const conditions: ReturnType<typeof sql>[] = [
              sql`m.embedding IS NOT NULL`,
            ];
            if (status) conditions.push(sql`m.status = ${status}`);
            if (type) conditions.push(sql`m.type = ${type}`);
            if (since) conditions.push(sql`m.created_at >= ${since}::timestamptz`);
            if (until) conditions.push(sql`m.created_at <= ${until}::timestamptz`);
            if (user_id) conditions.push(sql`m.related_user_ids @> ARRAY[${user_id}]::text[]`);

            const whereClause = sql.join(conditions, sql` AND `);

            const result = await db.execute(sql`
              SELECT m.id, m.content, m.type, m.status, m.created_at, m.source_thread_ts, m.source_channel_id,
                     1 - (m.embedding <=> ${vectorSql}) AS similarity
              FROM memories m
              ${entityJoin}
              WHERE ${whereClause}
              ORDER BY m.embedding <=> ${vectorSql}
              LIMIT ${limit}
            `);

            const rows = ((result as any).rows ?? result) as Array<Record<string, any>>;

            logger.info("search_memories tool called (semantic)", {
              query: query.substring(0, 100),
              type,
              status,
              entity: resolvedEntityName,
              resultCount: rows.length,
            });

            return {
              ok: true as const,
              mode: "semantic" as const,
              resolved_entity: resolvedEntityName,
              results: rows.map((r) => ({
                id: r.id,
                content: r.content.substring(0, 200) + (r.content.length > 200 ? "..." : ""),
                type: r.type,
                status: r.status,
                created_at: new Date(r.created_at).toISOString(),
                relevance_score: parseFloat(r.similarity).toFixed(3),
                source_thread_ts: r.source_thread_ts ?? null,
                source_channel_id: r.source_channel_id ?? null,
              })),
              count: rows.length,
            };
          }

          if (query?.trim()) {
            // Full-text search mode
            const conditions: ReturnType<typeof sql>[] = [];
            if (status) conditions.push(sql`m.status = ${status}`);
            if (type) conditions.push(sql`m.type = ${type}`);
            if (since) conditions.push(sql`m.created_at >= ${since}::timestamptz`);
            if (until) conditions.push(sql`m.created_at <= ${until}::timestamptz`);
            if (user_id) conditions.push(sql`m.related_user_ids @> ARRAY[${user_id}]::text[]`);

            const whereClause = conditions.length > 0
              ? sql`AND ${sql.join(conditions, sql` AND `)}`
              : sql``;

            // Try full-text search first, fall back to ILIKE
            const ftsResult = await db.execute(sql`
              SELECT m.id, m.content, m.type, m.status, m.created_at, m.source_thread_ts, m.source_channel_id,
                     ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', ${query})) AS rank
              FROM memories m
              ${entityJoin}
              WHERE to_tsvector('english', m.content) @@ plainto_tsquery('english', ${query})
              ${whereClause}
              ORDER BY rank DESC
              LIMIT ${limit}
            `);

            let rows = ((ftsResult as any).rows ?? ftsResult) as Array<Record<string, any>>;

            // Fallback to ILIKE if FTS returns nothing
            if (rows.length === 0) {
              const ilikeResult = await db.execute(sql`
                SELECT m.id, m.content, m.type, m.status, m.created_at, m.source_thread_ts, m.source_channel_id, 0 AS rank
                FROM memories m
                ${entityJoin}
                WHERE m.content ILIKE ${"%" + query + "%"}
                ${whereClause}
                ORDER BY m.created_at DESC
                LIMIT ${limit}
              `);
              rows = ((ilikeResult as any).rows ?? ilikeResult) as Array<Record<string, any>>;
            }

            logger.info("search_memories tool called (text)", {
              query: query.substring(0, 100),
              type,
              status,
              entity: resolvedEntityName,
              resultCount: rows.length,
            });

            return {
              ok: true as const,
              mode: "text" as const,
              resolved_entity: resolvedEntityName,
              results: rows.map((r) => ({
                id: r.id,
                content: r.content.substring(0, 200) + (r.content.length > 200 ? "..." : ""),
                type: r.type,
                status: r.status,
                created_at: new Date(r.created_at).toISOString(),
                relevance_score: parseFloat(r.rank).toFixed(3),
                source_thread_ts: r.source_thread_ts ?? null,
                source_channel_id: r.source_channel_id ?? null,
              })),
              count: rows.length,
            };
          }

          // Filter-only mode (no query)
          const conditions: ReturnType<typeof sql>[] = [];
          if (status) conditions.push(sql`m.status = ${status}`);
          if (type) conditions.push(sql`m.type = ${type}`);
          if (since) conditions.push(sql`m.created_at >= ${since}::timestamptz`);
          if (until) conditions.push(sql`m.created_at <= ${until}::timestamptz`);
          if (user_id) conditions.push(sql`m.related_user_ids @> ARRAY[${user_id}]::text[]`);

          const whereClause = conditions.length > 0
            ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
            : sql``;

          // When entity join is active, we need WHERE (or AND) differently
          let result;
          if (entityId) {
            const filterClause = conditions.length > 0
              ? sql`AND ${sql.join(conditions, sql` AND `)}`
              : sql``;
            result = await db.execute(sql`
              SELECT m.id, m.content, m.type, m.status, m.created_at, m.source_thread_ts, m.source_channel_id
              FROM memories m
              ${entityJoin}
              WHERE TRUE ${filterClause}
              ORDER BY m.created_at DESC
              LIMIT ${limit}
            `);
          } else {
            result = await db.execute(sql`
              SELECT m.id, m.content, m.type, m.status, m.created_at, m.source_thread_ts, m.source_channel_id
              FROM memories m
              ${whereClause}
              ORDER BY m.created_at DESC
              LIMIT ${limit}
            `);
          }

          const results = ((result as any).rows ?? result) as Array<Record<string, any>>;

          logger.info("search_memories tool called (filter)", {
            type,
            status,
            entity: resolvedEntityName,
            resultCount: results.length,
          });

          return {
            ok: true as const,
            mode: "filter" as const,
            resolved_entity: resolvedEntityName,
            results: results.map((r) => ({
              id: r.id,
              content: r.content.substring(0, 200) + (r.content.length > 200 ? "..." : ""),
              type: r.type,
              status: r.status,
              created_at: new Date(r.created_at).toISOString(),
              relevance_score: null,
              source_thread_ts: r.source_thread_ts ?? null,
              source_channel_id: r.source_channel_id ?? null,
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
        detail: (i) => i.entity ?? i.query ?? i.type ?? i.status ?? undefined,
        output: (r) => r.ok === false ? r.error : `${r.count} results${r.resolved_entity ? ` (entity: ${r.resolved_entity})` : ""}`,
      },
    }),

    search_entities: defineTool({
      description:
        "Search for entities (people, companies, products, projects, channels, technologies) by name. Returns matches ranked by similarity with memory counts and summaries. Use this to discover entity names before filtering search_memories by entity. Uses the same trigram index as the context builder.",
      inputSchema: z.object({
        query: z.string().describe("Entity name or partial name to search for"),
        type: z
          .enum(["person", "company", "channel", "technology", "product", "project"])
          .optional()
          .describe("Filter to a specific entity type"),
        limit: z.number().int().min(1).max(50).optional().default(20).describe("Max results (default 20)"),
      }),
      execute: async ({ query, type, limit }) => {
        try {
          const results = await searchEntities(query, DEFAULT_WORKSPACE_ID, { type, limit });

          logger.info("search_entities tool called", {
            query,
            type,
            resultCount: results.length,
          });

          return {
            ok: true as const,
            results: results.map((r) => ({
              entity_id: r.entityId,
              name: r.canonicalName,
              type: r.type,
              similarity: r.similarity.toFixed(3),
              memory_count: r.memoryCount,
              summary: r.summary,
            })),
            count: results.length,
          };
        } catch (error: any) {
          logger.error("search_entities tool failed", { error: error.message });
          return { ok: false as const, error: `Failed to search entities: ${error.message}` };
        }
      },
      slack: {
        status: "Searching entities...",
        detail: (i) => `${i.query}${i.type ? ` (${i.type})` : ""}`,
        output: (r) => r.ok === false ? r.error : `${r.count} entities found`,
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

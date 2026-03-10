import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { eq, and, gt, or, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes, jobs } from "@aura/db/schema";
import type { ScheduleContext } from "@aura/db/schema";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import { parseRelativeTime, formatTimestamp } from "../lib/temporal.js";
import { embedText } from "../lib/embeddings.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Add line numbers to content for display. */
function withLineNumbers(content: string): string {
  const lines = content.split("\n");
  const pad = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(pad)}| ${line}`)
    .join("\n");
}

/** Fetch a note by topic. */
async function getNoteByTopic(
  topic: string,
): Promise<{
  id: string;
  topic: string;
  content: string;
  category: string;
  expiresAt: Date | null;
  updatedAt: Date;
} | null> {
  const rows = await db
    .select()
    .from(notes)
    .where(eq(notes.topic, topic))
    .limit(1);
  return rows[0] ?? null;
}

/** Parse continuation depth from plan note content. */
function parseContinuationDepth(content: string): number {
  const match = content.match(/^## Continuations: (\d+)/m);
  return match ? parseInt(match[1]) : 0;
}

/** Fire-and-forget: embed note content and update the embedding column. Uses updatedAt guard to avoid stale writes. */
function updateNoteEmbedding(text: string, topic: string, savedAt: Date): void {
  embedText(text).then(embedding => {
    db.update(notes).set({ embedding }).where(and(eq(notes.topic, topic), eq(notes.updatedAt, savedAt))).catch(e => logger.error("Note embedding failed", { topic, error: String(e) }));
  }).catch(e => logger.error("Note embedText failed", { topic, error: String(e) }));
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

/**
 * Create note tools for the AI SDK.
 * These give the agent a persistent, mutable scratchpad with a three-tier hierarchy.
 *
 * @param context Optional schedule context for checkpoint_plan routing (channelId, threadTs, userId)
 */
export function createNoteTools(context?: ScheduleContext) {
  return {
    save_note: defineTool({
      description:
        "Create a new note or fully overwrite an existing one. Notes use a three-tier hierarchy: 'skill' (durable playbooks/protocols), 'plan' (ephemeral work-in-progress with expiry), 'knowledge' (general reference, default). Use for new notes or complete rewrites. For partial edits, use edit_note instead.",
      inputSchema: z.object({
        topic: z
          .string()
          .describe(
            "A short, descriptive topic key, e.g. 'bugs-weekly' or 'project-alpha-todos'",
          ),
        content: z
          .string()
          .describe("The full content of the note (markdown supported)"),
        category: z
          .enum(["skill", "plan", "knowledge"])
          .optional()
          .describe(
            "Note category: 'skill' for durable playbooks, 'plan' for ephemeral work-in-progress, 'knowledge' for general reference. Defaults to 'knowledge' for new notes. Omit to preserve existing category on update.",
          ),
        expires_in: z
          .string()
          .optional()
          .describe(
            "When this note should expire, e.g. '2 hours', '3 days', '1 week'. Mainly useful for plan notes. Omit for no expiry.",
          ),
      }),
      execute: async ({ topic, content, category, expires_in }) => {
        try {
          if (
            topic === "self-directive" &&
            !isAdmin(context?.userId) &&
            context?.userId !== "aura"
          ) {
            return { ok: false, error: "Only admins can edit the self-directive." };
          }

          let expiresAt: Date | null = null;
          if (expires_in) {
            const ms = parseRelativeTime(expires_in);
            if (!ms) {
              return {
                ok: false,
                error: `Could not parse expires_in "${expires_in}". Use formats like "30 minutes", "2 hours", "3 days", "1 week".`,
              };
            }
            expiresAt = new Date(Date.now() + ms);
          }

          const effectiveCategory = category ?? "knowledge";

          const savedAt = new Date();
          const updateSet: Record<string, unknown> = {
            content,
            embedding: null,
            updatedAt: savedAt,
          };
          if (category !== undefined) {
            updateSet.category = category;
          }
          if (expires_in !== undefined) {
            updateSet.expiresAt = expiresAt;
          }

          await db
            .insert(notes)
            .values({
              topic,
              content,
              category: effectiveCategory,
              expiresAt,
              updatedAt: savedAt,
            })
            .onConflictDoUpdate({
              target: notes.topic,
              set: updateSet,
            });

          updateNoteEmbedding(content, topic, savedAt);

          logger.info("save_note tool called", {
            topic,
            category: effectiveCategory,
            contentLength: content.length,
          });

          return {
            ok: true,
            message: `Note "${topic}" saved (${effectiveCategory}, ${content.split("\n").length} lines${expiresAt ? `, expires ${expiresAt.toISOString()}` : ""})`,
          };
        } catch (error: any) {
          logger.error("save_note tool failed", {
            topic,
            error: error.message,
          });
          return { ok: false, error: `Failed to save note: ${error.message}` };
        }
      },
      slack: { status: "Saving note...", detail: (i) => i.topic },
    }),

    read_note: defineTool({
      description:
        "Read a note by topic. Returns the content with line numbers so you can reference specific lines for edit_note's replace_lines or insert_after_line operations. Check the notes-index first to orient, then use search_notes to find, then read_note to load.",
      inputSchema: z.object({
        topic: z.string().describe("The topic key of the note to read"),
      }),
      execute: async ({ topic }) => {
        try {
          const note = await getNoteByTopic(topic);
          if (!note) {
            return {
              ok: false,
              error: `No note found with topic "${topic}". Use list_notes to see available notes.`,
            };
          }

          const numbered = withLineNumbers(note.content);
          const lineCount = note.content.split("\n").length;

          logger.info("read_note tool called", { topic, lineCount });

          return {
            ok: true,
            topic: note.topic,
            category: note.category,
            content: numbered,
            line_count: lineCount,
            updated_at: formatTimestamp(note.updatedAt, context?.timezone),
            expires_at: note.expiresAt ? formatTimestamp(note.expiresAt, context?.timezone) : null,
          };
        } catch (error: any) {
          logger.error("read_note tool failed", {
            topic,
            error: error.message,
          });
          return { ok: false, error: `Failed to read note: ${error.message}` };
        }
      },
      slack: { status: "Reading note...", detail: (i) => i.topic },
    }),

    list_notes: defineTool({
      description:
        "List all saved notes with their topics, category, a short preview, and last updated time. Can filter by category.",
      inputSchema: z.object({
        category: z
          .enum(["skill", "plan", "knowledge"])
          .optional()
          .describe("Filter by category. Omit to list all."),
      }),
      execute: async ({ category }) => {
        try {
          const now = new Date();
          const conditions = [];

          if (category) {
            conditions.push(eq(notes.category, category));
          }

          // Filter out expired notes
          conditions.push(
            or(isNull(notes.expiresAt), gt(notes.expiresAt, now))!,
          );

          const allNotes = await db
            .select({
              topic: notes.topic,
              content: notes.content,
              category: notes.category,
              expiresAt: notes.expiresAt,
              updatedAt: notes.updatedAt,
            })
            .from(notes)
            .where(and(...conditions))
            .orderBy(notes.updatedAt);

          const result = allNotes.map((n) => ({
            topic: n.topic,
            category: n.category,
            preview:
              n.content.substring(0, 80) +
              (n.content.length > 80 ? "..." : ""),
            lines: n.content.split("\n").length,
            updated_at: formatTimestamp(n.updatedAt, context?.timezone),
            expires_at: n.expiresAt ? formatTimestamp(n.expiresAt, context?.timezone) : null,
          }));

          logger.info("list_notes tool called", {
            category,
            count: result.length,
          });

          return {
            ok: true,
            notes: result,
            count: result.length,
          };
        } catch (error: any) {
          logger.error("list_notes tool failed", { error: error.message });
          return { ok: false, error: `Failed to list notes: ${error.message}` };
        }
      },
      slack: { status: "Listing notes..." },
    }),

    edit_note: defineTool({
      description:
        "Surgically edit an existing note without rewriting the whole thing. Supports: 'append' (add to end), 'prepend' (add to start), 'replace_lines' (replace a range of lines), 'insert_after_line' (insert after a specific line). Always use read_note first to see line numbers. Prefer this over save_note for partial updates.",
      inputSchema: z.object({
        topic: z.string().describe("The topic key of the note to edit"),
        operation: z
          .enum(["append", "prepend", "replace_lines", "insert_after_line"])
          .describe("The type of edit to perform"),
        content: z
          .string()
          .describe("The new content to append, prepend, or insert"),
        start_line: z
          .number()
          .optional()
          .describe(
            "First line to replace (1-indexed, inclusive). Required for replace_lines.",
          ),
        end_line: z
          .number()
          .optional()
          .describe(
            "Last line to replace (1-indexed, inclusive). Required for replace_lines.",
          ),
        line: z
          .number()
          .optional()
          .describe(
            "Line number to insert after (1-indexed). Required for insert_after_line.",
          ),
      }),
      execute: async ({
        topic,
        operation,
        content,
        start_line,
        end_line,
        line,
      }) => {
        try {
          if (
            topic === "self-directive" &&
            !isAdmin(context?.userId) &&
            context?.userId !== "aura"
          ) {
            return { ok: false, error: "Only admins can edit the self-directive." };
          }

          const note = await getNoteByTopic(topic);
          if (!note) {
            return {
              ok: false,
              error: `No note found with topic "${topic}". Use save_note to create it first.`,
            };
          }

          const lines = note.content.split("\n");
          let newContent: string;

          switch (operation) {
            case "append":
              newContent = note.content + "\n" + content;
              break;

            case "prepend":
              newContent = content + "\n" + note.content;
              break;

            case "replace_lines": {
              if (start_line == null || end_line == null) {
                return {
                  ok: false,
                  error:
                    "replace_lines requires start_line and end_line parameters.",
                };
              }
              if (
                start_line < 1 ||
                end_line < start_line ||
                start_line > lines.length
              ) {
                return {
                  ok: false,
                  error: `Invalid line range: ${start_line}-${end_line}. Note has ${lines.length} lines.`,
                };
              }
              const clampedEnd = Math.min(end_line, lines.length);
              const newLines = content.split("\n");
              lines.splice(
                start_line - 1,
                clampedEnd - start_line + 1,
                ...newLines,
              );
              newContent = lines.join("\n");
              break;
            }

            case "insert_after_line": {
              if (line == null) {
                return {
                  ok: false,
                  error: "insert_after_line requires the line parameter.",
                };
              }
              if (line < 0 || line > lines.length) {
                return {
                  ok: false,
                  error: `Invalid line number: ${line}. Note has ${lines.length} lines. Use 0 to insert at the very top.`,
                };
              }
              const insertLines = content.split("\n");
              lines.splice(line, 0, ...insertLines);
              newContent = lines.join("\n");
              break;
            }

            default:
              return { ok: false, error: `Unknown operation: ${operation}` };
          }

          const savedAt = new Date();
          await db
            .update(notes)
            .set({ content: newContent, embedding: null, updatedAt: savedAt })
            .where(eq(notes.topic, topic));

          updateNoteEmbedding(newContent, topic, savedAt);

          const finalLineCount = newContent.split("\n").length;

          logger.info("edit_note tool called", {
            topic,
            operation,
            resultLines: finalLineCount,
          });

          return {
            ok: true,
            message: `Note "${topic}" updated (${operation}). Now ${finalLineCount} lines.`,
          };
        } catch (error: any) {
          logger.error("edit_note tool failed", {
            topic,
            operation,
            error: error.message,
          });
          return { ok: false, error: `Failed to edit note: ${error.message}` };
        }
      },
      slack: { status: "Editing note...", detail: (i) => i.topic },
    }),

    delete_note: defineTool({
      description: "Delete a note entirely by topic.",
      inputSchema: z.object({
        topic: z.string().describe("The topic key of the note to delete"),
      }),
      execute: async ({ topic }) => {
        try {
          if (
            topic === "self-directive" &&
            !isAdmin(context?.userId) &&
            context?.userId !== "aura"
          ) {
            return { ok: false, error: "Only admins can delete the self-directive." };
          }

          const note = await getNoteByTopic(topic);
          if (!note) {
            return {
              ok: false,
              error: `No note found with topic "${topic}".`,
            };
          }

          await db.delete(notes).where(eq(notes.topic, topic));

          logger.info("delete_note tool called", { topic });

          return {
            ok: true,
            message: `Note "${topic}" deleted.`,
          };
        } catch (error: any) {
          logger.error("delete_note tool failed", {
            topic,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to delete note: ${error.message}`,
          };
        }
      },
      slack: { status: "Deleting note...", detail: (i) => i.topic },
    }),

    // ── Full-text Search ────────────────────────────────────────────────────

    search_notes: defineTool({
      description:
        "Full-text search across all notes content. Use this before reading individual notes when looking for a keyword or term — saves tool calls vs. list_notes + sequential read_note. Supports two modes: 'text' (default, keyword search) and 'semantic' (vector similarity for conceptual matches). The navigation pattern is: notes-index (orient) → search_notes (find) → read_note (load).",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Search term or phrase to find across all notes"),
        mode: z
          .enum(["text", "semantic"])
          .default("text")
          .describe("Search mode: 'text' for keyword/full-text search, 'semantic' for vector similarity search"),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe("Max results to return (default 10)"),
      }),
      execute: async ({ query, mode, limit }) => {
        try {
          const trimmed = query.trim();
          if (!trimmed) {
            return { ok: false, error: "Query cannot be empty." };
          }

          if (mode === "semantic") {
            const queryEmbedding = await embedText(trimmed);
            const embeddingLiteral = JSON.stringify(queryEmbedding);

            const results = await db
              .select({
                topic: notes.topic,
                category: notes.category,
                content: notes.content,
                updatedAt: notes.updatedAt,
                similarity: sql<number>`1 - (${notes.embedding} <=> ${embeddingLiteral}::vector)`.as("similarity"),
              })
              .from(notes)
              .where(
                and(
                  sql`${notes.embedding} IS NOT NULL`,
                  or(isNull(notes.expiresAt), gt(notes.expiresAt, new Date()))!,
                ),
              )
              .orderBy(sql`${notes.embedding} <=> ${embeddingLiteral}::vector`)
              .limit(limit);

            logger.info("search_notes tool called (semantic)", {
              query: trimmed,
              resultCount: results.length,
            });

            return {
              ok: true,
              mode: "semantic",
              results: results.map((r) => ({
                topic: r.topic,
                category: r.category,
                snippet: r.content.substring(0, 200) + (r.content.length > 200 ? "..." : ""),
                similarity: Math.round(r.similarity * 1000) / 1000,
                updated_at: r.updatedAt.toISOString(),
              })),
              count: results.length,
            };
          }

          // mode === "text": existing tsvector + ILIKE fallback
          let rows: any[];
          try {
            const results = await db.execute(sql`
              SELECT topic, category, updated_at,
                ts_headline('english', unaccent(content),
                  websearch_to_tsquery('english', unaccent(${trimmed})),
                  'StartSel=>>>, StopSel=<<<, MaxWords=35, MinWords=15'
                ) as snippet,
                ts_rank(
                  to_tsvector('english', unaccent(content)),
                  websearch_to_tsquery('english', unaccent(${trimmed}))
                ) as rank
              FROM notes
              WHERE to_tsvector('english', unaccent(content))
                @@ websearch_to_tsquery('english', unaccent(${trimmed}))
                AND (expires_at IS NULL OR expires_at > now())
              ORDER BY rank DESC
              LIMIT ${limit}
            `);
            rows = (results as any).rows ?? results;
          } catch (err) {
            logger.warn("tsvector search failed, falling back to ILIKE", {
              error: err instanceof Error ? err.message : String(err),
            });
            const escaped = trimmed.replace(/[\\%_]/g, "\\$&");
            const pattern = `%${escaped.toLowerCase()}%`;
            const results = await db.execute(sql`
              SELECT topic, category, updated_at,
                substring(content from greatest(1, position(lower(${trimmed}) in lower(content)) - 100)
                  for 200) as snippet
              FROM notes
              WHERE lower(content) LIKE ${pattern} ESCAPE '\\'
                AND (expires_at IS NULL OR expires_at > now())
              ORDER BY updated_at DESC
              LIMIT ${limit}
            `);
            rows = (results as any).rows ?? results;
          }

          logger.info("search_notes tool called (text)", {
            query: trimmed,
            resultCount: rows.length,
          });

          return {
            ok: true,
            mode: "text",
            results: rows.map((r: any) => ({
              topic: r.topic,
              category: r.category,
              snippet: r.snippet,
              updated_at: r.updated_at,
            })),
            count: rows.length,
          };
        } catch (error: any) {
          logger.error("search_notes tool failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to search notes: ${error.message}`,
          };
        }
      },
      slack: { status: "Searching notes...", detail: (i) => i.query },
    }),

    // ── Plan Continuation ──────────────────────────────────────────────────

    checkpoint_plan: defineTool({
      description:
        "Save progress on a multi-step task and schedule a continuation. Use this when approaching your step limit and you won't finish in time. Atomically saves a plan note AND schedules a follow-up action.",
      inputSchema: z.object({
        topic: z
          .string()
          .describe("Plan note topic (will create or update)"),
        progress: z
          .string()
          .describe("What has been accomplished so far"),
        next_steps: z
          .string()
          .describe(
            "Specific instructions for the next continuation — be precise, your future self needs this",
          ),
        context: z
          .string()
          .describe(
            "Accumulated findings, data, intermediate results. Keep concise.",
          ),
        continue_in_minutes: z
          .number()
          .default(5)
          .describe("Minutes until continuation fires (default 5)"),
      }),
      execute: async ({
        topic,
        progress,
        next_steps,
        context: ctx,
        continue_in_minutes,
      }) => {
        try {
          if (
            topic === "self-directive" &&
            !isAdmin(context?.userId) &&
            context?.userId !== "aura"
          ) {
            return { ok: false, error: "Only admins can edit the self-directive." };
          }

          // Reject topics containing ']' — they break the [CONTINUE:topic] tag parser
          if (topic.includes("]")) {
            return {
              ok: false,
              error: `Topic must not contain ']' characters (breaks continuation tag parsing). Got: "${topic}"`,
            };
          }

          // Read existing plan note to check continuation depth
          const existing = await getNoteByTopic(topic);
          let depth = 0;
          if (existing) {
            depth = parseContinuationDepth(existing.content);
          }

          const MAX_CONTINUATIONS = 5;

          if (depth >= MAX_CONTINUATIONS) {
            // Depth limit reached — don't schedule continuation
            const noteContent = `## Continuations: ${depth}\n## Status: waiting\n\n## Progress\n${progress}\n\n## Next Steps\n${next_steps}\n\n## Context\n${ctx}`;
            const sevenDays = new Date(
              Date.now() + 7 * 24 * 60 * 60 * 1000,
            );
            const savedAt = new Date();

            await db
              .insert(notes)
              .values({
                topic,
                content: noteContent,
                category: "plan",
                expiresAt: sevenDays,
                updatedAt: savedAt,
              })
              .onConflictDoUpdate({
                target: notes.topic,
                set: {
                  content: noteContent,
                  category: "plan",
                  embedding: null,
                  expiresAt: sevenDays,
                  updatedAt: savedAt,
                },
              });

            updateNoteEmbedding(noteContent, topic, savedAt);

            logger.info("checkpoint_plan: depth limit reached", {
              topic,
              depth,
            });

            return {
              ok: true,
              message: `Plan "${topic}" saved but continuation depth limit (${MAX_CONTINUATIONS}) reached. Ask the user if they want you to keep going.`,
              depth_limit_reached: true,
              continuations: depth,
            };
          }

          // Build the plan note content with incremented depth
          const newDepth = depth + 1;
          const noteContent = `## Continuations: ${newDepth}\n\n## Progress\n${progress}\n\n## Next Steps\n${next_steps}\n\n## Context\n${ctx}`;
          const sevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

          // Upsert the plan note and schedule continuation
          const executeAt = new Date(
            Date.now() + continue_in_minutes * 60 * 1000,
          );
          const description = `[CONTINUE:${topic}] ${next_steps}`;
          const savedAt = new Date();

          // 1. Upsert the plan note
          await db
            .insert(notes)
            .values({
              topic,
              content: noteContent,
              category: "plan",
              expiresAt: sevenDays,
              updatedAt: savedAt,
            })
            .onConflictDoUpdate({
              target: notes.topic,
              set: {
                content: noteContent,
                category: "plan",
                embedding: null,
                expiresAt: sevenDays,
                updatedAt: savedAt,
              },
            });

          updateNoteEmbedding(noteContent, topic, savedAt);

          // 2. Insert a continuation job with channelId + threadTs for routing
          await db.insert(jobs).values({
            name: `continue-${topic}-${Date.now().toString(36)}`,
            description,
            executeAt,
            channelId: context?.channelId || "",
            threadTs: context?.threadTs || null,
            requestedBy: context?.userId || "aura",
            priority: "high",
          });

          logger.info("checkpoint_plan tool called", {
            topic,
            depth: newDepth,
            continueAt: executeAt.toISOString(),
          });

          return {
            ok: true,
            message: `Plan "${topic}" saved (continuation ${newDepth}/${MAX_CONTINUATIONS}). Resuming at ${executeAt.toISOString()}.`,
            continue_at: executeAt.toISOString(),
            continuations: newDepth,
          };
        } catch (error: any) {
          logger.error("checkpoint_plan tool failed", {
            topic,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to checkpoint plan: ${error.message}`,
          };
        }
      },
      slack: { status: "Saving checkpoint...", detail: (i) => i.topic },
    }),
  };
}

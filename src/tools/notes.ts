import { tool } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes } from "../db/schema.js";
import { logger } from "../lib/logger.js";

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
): Promise<{ id: string; topic: string; content: string; updatedAt: Date } | null> {
  const rows = await db
    .select()
    .from(notes)
    .where(eq(notes.topic, topic))
    .limit(1);
  return rows[0] ?? null;
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

/**
 * Create note tools for the AI SDK.
 * These give the agent a persistent, mutable scratchpad.
 */
export function createNoteTools() {
  return {
    save_note: tool({
      description:
        "Create a new note or fully overwrite an existing one. Use for new notes or complete rewrites. For partial edits, use edit_note instead.",
      inputSchema: z.object({
        topic: z
          .string()
          .describe("A short, descriptive topic key, e.g. 'bugs-weekly' or 'project-alpha-todos'"),
        content: z
          .string()
          .describe("The full content of the note (markdown supported)"),
      }),
      execute: async ({ topic, content }) => {
        try {
          await db
            .insert(notes)
            .values({ topic, content, updatedAt: new Date() })
            .onConflictDoUpdate({
              target: notes.topic,
              set: { content, updatedAt: new Date() },
            });

          logger.info("save_note tool called", { topic, contentLength: content.length });

          return {
            ok: true,
            message: `Note "${topic}" saved (${content.split("\n").length} lines)`,
          };
        } catch (error: any) {
          logger.error("save_note tool failed", { topic, error: error.message });
          return { ok: false, error: `Failed to save note: ${error.message}` };
        }
      },
    }),

    read_note: tool({
      description:
        "Read a note by topic. Returns the content with line numbers so you can reference specific lines for edit_note operations.",
      inputSchema: z.object({
        topic: z
          .string()
          .describe("The topic key of the note to read"),
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
            content: numbered,
            line_count: lineCount,
            updated_at: note.updatedAt.toISOString(),
          };
        } catch (error: any) {
          logger.error("read_note tool failed", { topic, error: error.message });
          return { ok: false, error: `Failed to read note: ${error.message}` };
        }
      },
    }),

    list_notes: tool({
      description:
        "List all saved notes with their topics, a short preview, and last updated time.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const allNotes = await db
            .select({
              topic: notes.topic,
              content: notes.content,
              updatedAt: notes.updatedAt,
            })
            .from(notes)
            .orderBy(notes.updatedAt);

          const result = allNotes.map((n) => ({
            topic: n.topic,
            preview: n.content.substring(0, 80) + (n.content.length > 80 ? "..." : ""),
            lines: n.content.split("\n").length,
            updated_at: n.updatedAt.toISOString(),
          }));

          logger.info("list_notes tool called", { count: result.length });

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
    }),

    edit_note: tool({
      description:
        "Surgically edit an existing note. Supports: 'append' (add to end), 'prepend' (add to start), 'replace_lines' (replace a range of lines), 'insert_after_line' (insert after a specific line). Use read_note first to see line numbers.",
      inputSchema: z.object({
        topic: z
          .string()
          .describe("The topic key of the note to edit"),
        operation: z
          .enum(["append", "prepend", "replace_lines", "insert_after_line"])
          .describe("The type of edit to perform"),
        content: z
          .string()
          .describe("The new content to append, prepend, or insert"),
        start_line: z
          .number()
          .optional()
          .describe("First line to replace (1-indexed, inclusive). Required for replace_lines."),
        end_line: z
          .number()
          .optional()
          .describe("Last line to replace (1-indexed, inclusive). Required for replace_lines."),
        line: z
          .number()
          .optional()
          .describe("Line number to insert after (1-indexed). Required for insert_after_line."),
      }),
      execute: async ({ topic, operation, content, start_line, end_line, line }) => {
        try {
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
                  error: "replace_lines requires start_line and end_line parameters.",
                };
              }
              if (start_line < 1 || end_line < start_line || start_line > lines.length) {
                return {
                  ok: false,
                  error: `Invalid line range: ${start_line}-${end_line}. Note has ${lines.length} lines.`,
                };
              }
              const clampedEnd = Math.min(end_line, lines.length);
              const newLines = content.split("\n");
              lines.splice(start_line - 1, clampedEnd - start_line + 1, ...newLines);
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

          await db
            .update(notes)
            .set({ content: newContent, updatedAt: new Date() })
            .where(eq(notes.topic, topic));

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
    }),

    delete_note: tool({
      description:
        "Delete a note entirely by topic.",
      inputSchema: z.object({
        topic: z
          .string()
          .describe("The topic key of the note to delete"),
      }),
      execute: async ({ topic }) => {
        try {
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
          logger.error("delete_note tool failed", { topic, error: error.message });
          return { ok: false, error: `Failed to delete note: ${error.message}` };
        }
      },
    }),
  };
}

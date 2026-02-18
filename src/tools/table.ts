import { tool } from "ai";
import { z } from "zod";
import { logger } from "../lib/logger.js";

/**
 * Sentinel key used by the pipeline to detect table blocks in tool results.
 * When the LLM calls draw_table, the execute function returns the built
 * Slack TableBlock under this key. The streaming loop in respond.ts captures
 * it and injects it into `streamer.stop({ blocks: [tableBlock] })` so the
 * table renders natively as part of the same message.
 */
export const TABLE_BLOCK_KEY = "__table_block";

export function createTableTools() {
  return {
    draw_table: tool({
      description:
        "Render structured data as a native Slack table at the bottom of your reply. " +
        "Use this instead of markdown tables whenever you have tabular data " +
        "(comparisons, query results, lists with multiple columns, etc.). " +
        "Only one table per message. Max 100 rows, 20 columns. " +
        "The first row you provide in `rows` becomes the header row.",
      inputSchema: z.object({
        rows: z
          .array(z.array(z.string().describe("Cell text")))
          .min(2, "Need at least a header row and one data row")
          .max(100, "Max 100 rows including header")
          .describe(
            "Array of rows. The FIRST row is the header row. Each row is an array of cell strings. All rows must have the same number of columns (max 20).",
          ),
        column_alignments: z
          .array(z.enum(["left", "center", "right"]))
          .optional()
          .describe(
            "Optional per-column alignment. Array length should match column count. Defaults to left.",
          ),
      }),
      execute: async ({ rows, column_alignments }) => {
        if (rows.length < 2) {
          return { ok: false, error: "Need at least a header row and one data row." };
        }

        const colCount = rows[0].length;
        if (colCount > 20) {
          return { ok: false, error: "Max 20 columns allowed." };
        }

        for (let i = 0; i < rows.length; i++) {
          if (rows[i].length !== colCount) {
            return {
              ok: false,
              error: `Row ${i} has ${rows[i].length} columns but header has ${colCount}. All rows must have the same number of columns.`,
            };
          }
        }

        if (column_alignments && column_alignments.length !== colCount) {
          return {
            ok: false,
            error: `column_alignments has ${column_alignments.length} entries but there are ${colCount} columns. Length must match column count.`,
          };
        }

        const tableBlock = {
          type: "table" as const,
          rows: rows.map((row) =>
            row.map((cell) => ({ type: "raw_text" as const, text: cell })),
          ),
          ...(column_alignments
            ? {
                column_settings: column_alignments.map((align) => ({
                  align,
                  is_wrapped: true,
                })),
              }
            : {
                column_settings: Array.from({ length: colCount }, () => ({
                  is_wrapped: true,
                })),
              }),
        };

        logger.info("draw_table tool called", {
          columns: colCount,
          rows: rows.length - 1, // exclude header
        });

        return { ok: true, [TABLE_BLOCK_KEY]: tableBlock };
      },
    }),
  };
}

import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import type { WebClient } from "@slack/web-api";
import { logger } from "../lib/logger.js";
import { formatForSlack } from "../lib/format.js";
import { resolveChannelByName, resolveUserByName } from "./slack.js";
import type { ScheduleContext } from "@aura/db/schema";
import { formatTimestamp } from "../lib/temporal.js";

/**
 * Sentinel key used by the pipeline to detect table blocks in tool results.
 * When draw_table is called in inline mode, the execute function returns the
 * built Slack TableBlock under this key. The streaming loop in respond.ts
 * captures it and injects it into `streamer.stop({ blocks: [tableBlock] })` so
 * the table renders natively as part of the same message.
 */
export const TABLE_BLOCK_KEY = "__table_block";

function buildTableBlock(
  rows: string[][],
  columnAlignments?: ("left" | "center" | "right")[],
) {
  const colCount = rows[0].length;
  return {
    type: "table" as const,
    rows: rows.map((row) =>
      row.map((cell) => ({ type: "raw_text" as const, text: cell })),
    ),
    column_settings: columnAlignments
      ? columnAlignments.map((align) => ({ align, is_wrapped: true }))
      : Array.from({ length: colCount }, () => ({ is_wrapped: true })),
  };
}

function validateRows(rows: string[][]) {
  if (rows.length < 2) {
    return "Need at least a header row and one data row.";
  }
  const colCount = rows[0].length;
  if (colCount > 20) {
    return "Max 20 columns allowed.";
  }
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length !== colCount) {
      return `Row ${i} has ${rows[i].length} columns but header has ${colCount}. All rows must match.`;
    }
  }
  return null;
}

async function postTable(
  client: WebClient,
  channelId: string,
  tableBlock: Record<string, any>,
  message?: string,
  threadTs?: string,
) {
  // Use chat.postMessage directly (not safePostMessage) because for tables
  // the block IS the content — stripping blocks on error would silently
  // discard the table data and mislead the caller into thinking it succeeded.
  return client.chat.postMessage({
    channel: channelId,
    text: formatForSlack(message || "Here's a table:"),
    blocks: [tableBlock as any],
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
}

export function createTableTools(client: WebClient, context?: ScheduleContext) {
  return {
    draw_table: defineTool({
      description:
        "Render structured data as a native Slack table. " +
        "Use this instead of markdown tables whenever you have tabular data " +
        "(comparisons, query results, lists with multiple columns, etc.). " +
        "The first row in `rows` becomes the header row.\n\n" +
        "Three modes:\n" +
        "- **Inline** (default): table attaches to the bottom of your current reply. " +
        "Limited to one table per reply. Best for a single table.\n" +
        "- **Reply** (`send_as_reply: true`): posts the table as a separate thread " +
        "reply in the current conversation. Use this when you need multiple tables " +
        "— they appear in the thread as you work. Include `message` for context.\n" +
        "- **Targeted** (`target_channel` or `target_user`): posts the table to " +
        "a different channel or DM. Include `message` for context.",
      inputSchema: z.object({
        rows: z
          .array(z.array(z.string().describe("Cell text")))
          .min(2, "Need at least a header row and one data row")
          .max(100, "Max 100 rows including header")
          .describe(
            "Array of rows. The FIRST row is the header. Each row is an array of cell strings. All rows must have the same column count (max 20).",
          ),
        column_alignments: z
          .array(z.enum(["left", "center", "right"]))
          .optional()
          .describe("Optional per-column alignment. Defaults to left."),
        send_as_reply: z
          .boolean()
          .optional()
          .describe(
            "Post the table as a thread reply in the current conversation instead of inline. " +
            "Use when sending multiple tables.",
          ),
        target_channel: z
          .string()
          .optional()
          .describe(
            "Channel name or ID to post the table to. Mutually exclusive with target_user and send_as_reply.",
          ),
        target_user: z
          .string()
          .optional()
          .describe(
            "User display name or ID to DM the table to. Mutually exclusive with target_channel and send_as_reply.",
          ),
        thread_ts: z
          .string()
          .optional()
          .describe("Thread timestamp for targeted posts — post the table as a thread reply."),
        message: z
          .string()
          .optional()
          .describe("Text above the table. Recommended for reply and targeted modes."),
      }),
      execute: async ({
        rows,
        column_alignments,
        send_as_reply,
        target_channel,
        target_user,
        thread_ts,
        message,
      }) => {
        const error = validateRows(rows);
        if (error) return { ok: false, error };

        const colCount = rows[0].length;

        if (column_alignments && column_alignments.length !== colCount) {
          return {
            ok: false,
            error: `column_alignments has ${column_alignments.length} entries but there are ${colCount} columns. Length must match column count.`,
          };
        }

        if ((target_channel || target_user) && send_as_reply) {
          return { ok: false, error: "Use send_as_reply OR target_channel/target_user, not both." };
        }
        if (target_channel && target_user) {
          return { ok: false, error: "Set target_channel or target_user, not both." };
        }

        const tableBlock = buildTableBlock(rows, column_alignments);

        // ── Inline mode: return block for pipeline injection ──────────
        if (!target_channel && !target_user && !send_as_reply) {
          logger.info("draw_table tool called (inline)", {
            columns: colCount,
            rows: rows.length - 1,
          });
          return { ok: true, [TABLE_BLOCK_KEY]: tableBlock };
        }

        // ── Reply mode: post in the current conversation thread ──────
        if (send_as_reply) {
          if (!context?.channelId || !context?.threadTs) {
            return {
              ok: false,
              error: "No current conversation context available for send_as_reply.",
            };
          }

          try {
            const result = await postTable(
              client, context.channelId, tableBlock, message, context.threadTs,
            );
            logger.info("draw_table tool called (reply)", {
              channelId: context.channelId,
              threadTs: context.threadTs,
              columns: colCount,
              rows: rows.length - 1,
              messageTs: result.ts,
            });
            return {
              ok: true,
              message: "Table posted as a thread reply.",
              ts: result.ts,
              time: formatTimestamp(result.ts, context?.timezone),
            };
          } catch (err: any) {
            logger.error("draw_table (reply) failed", { error: err.message });
            return { ok: false, error: `Failed to post table reply: ${err.message}` };
          }
        }

        // ── Targeted mode: post to a specific channel or DM ──────────
        try {
          let channelId: string;

          if (target_user) {
            const user = await resolveUserByName(client, target_user);
            if (!user) {
              return { ok: false, error: `Could not find user "${target_user}".` };
            }
            const dm = await client.conversations.open({ users: user.id });
            if (!dm.channel?.id) {
              return { ok: false, error: `Failed to open DM with ${user.name}.` };
            }
            channelId = dm.channel.id;
          } else {
            const channel = await resolveChannelByName(client, target_channel!);
            if (!channel) {
              return { ok: false, error: `Could not find channel "${target_channel}".` };
            }
            channelId = channel.id;
          }

          const result = await postTable(
            client, channelId, tableBlock, message, thread_ts,
          );

          const targetLabel = target_user || target_channel;
          logger.info("draw_table tool called (targeted)", {
            target: targetLabel,
            columns: colCount,
            rows: rows.length - 1,
            messageTs: result.ts,
          });

          return {
            ok: true,
            message: `Table sent to ${target_user ? target_user : `#${target_channel}`}`,
            ts: result.ts,
            time: formatTimestamp(result.ts, context?.timezone),
          };
        } catch (err: any) {
          logger.error("draw_table (targeted) failed", { error: err.message });
          return { ok: false, error: `Failed to send table: ${err.message}` };
        }
      },
      slack: { status: "Drawing table..." },
    }),
  };
}

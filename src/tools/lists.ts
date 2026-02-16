import { tool } from "ai";
import { z } from "zod";
import type { WebClient } from "@slack/web-api";
import { logger } from "../lib/logger.js";
import { throttle } from "./rate-limit.js";

/**
 * Convert the LLM-facing field format (column_id -> typed value) into
 * the Slack API's `cells` array format.
 *
 * The LLM passes fields like:
 *   { "Col088NN1RAUV": { "select": ["in_progress"] }, "Col088B1KQX5M": { "rich_text": [...] } }
 *
 * The API expects `cells`:
 *   [{ column_id: "Col088NN1RAUV", row_id: "Rec...", select: ["in_progress"] }, ...]
 *
 * We also accept shorthand for common types:
 *   { "Col088NN1RAUV": ["in_progress"] }  → select (array of strings)
 *   { "Col088NN1RAUV": "some text" }       → rich_text (auto-wrapped)
 */
function buildCells(
  fields: Record<string, any>,
  rowId: string,
): any[] {
  return Object.entries(fields).map(([columnId, value]) => {
    const cell: any = { column_id: columnId, row_id: rowId };

    if (value && typeof value === "object" && !Array.isArray(value)) {
      // Already typed: { rich_text: [...], select: [...], user: [...], date: [...] }
      // Merge the typed keys directly into the cell
      Object.assign(cell, value);
    } else if (Array.isArray(value)) {
      // Shorthand array — detect type from content
      if (value.length > 0 && typeof value[0] === "object" && value[0].type === "rich_text") {
        cell.rich_text = value;
      } else if (value.length > 0 && typeof value[0] === "string") {
        // Could be select values or user IDs — check if they look like user IDs (U/W prefix)
        if (/^[UW][A-Z0-9]+$/.test(value[0])) {
          cell.user = value;
        } else {
          cell.select = value;
        }
      } else if (value.length > 0 && typeof value[0] === "number") {
        cell.timestamp = value;
      } else {
        // Fall through — pass as-is and let API validate
        cell.value = value;
      }
    } else if (typeof value === "string") {
      // Plain string → wrap in rich_text block
      cell.rich_text = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: value }],
            },
          ],
        },
      ];
    } else {
      // Number, boolean, etc. — pass as value
      cell.value = value;
    }

    return cell;
  });
}

/**
 * Convert the LLM-facing field format into the `initial_fields` array
 * for slackLists.items.create. Same typed structure as cells but without row_id.
 */
function buildInitialFields(fields: Record<string, any>): any[] {
  return Object.entries(fields).map(([columnId, value]) => {
    const field: any = { column_id: columnId };

    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(field, value);
    } else if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] === "object" && value[0].type === "rich_text") {
        field.rich_text = value;
      } else if (value.length > 0 && typeof value[0] === "string") {
        if (/^[UW][A-Z0-9]+$/.test(value[0])) {
          field.user = value;
        } else {
          field.select = value;
        }
      } else if (value.length > 0 && typeof value[0] === "number") {
        field.timestamp = value;
      } else {
        field.value = value;
      }
    } else if (typeof value === "string") {
      field.rich_text = [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: value }],
            },
          ],
        },
      ];
    } else {
      field.value = value;
    }

    return field;
  });
}

/**
 * Create Slack Lists write tools.
 * Read tools (list_slack_list_items, get_slack_list_item) remain in slack.ts.
 */
export function createListWriteTools(client: WebClient) {
  return {
    create_slack_list_item: tool({
      description:
        "Create a new item (row) in a Slack List. Useful for adding bugs, tasks, or records to a tracker.",
      inputSchema: z.object({
        list_id: z.string().describe("The ID of the Slack List"),
        fields: z
          .record(z.any())
          .optional()
          .describe(
            "Column values as a JSON object of column_id -> value pairs. " +
            "Use get_slack_list_item on an existing item to see the column IDs and value formats. " +
            "Values must match the exact format returned by get_slack_list_item."
          ),
      }),
      execute: async ({ list_id, fields }) => {
        try {
          await throttle();
          const params: any = { list_id };
          if (fields) {
            params.initial_fields = buildInitialFields(fields);
          }

          const result = await (client as any).apiCall("slackLists.items.create", params);

          if (!result.ok) {
            logger.error("create_slack_list_item API error", { list_id, error: result.error, response_metadata: result.response_metadata });
            return { ok: false, error: `Failed to create list item: ${result.error || "unknown"}` };
          }

          logger.info("create_slack_list_item tool called", { list_id, itemId: result.item?.id });
          return { ok: true, item_id: result.item?.id, message: "List item created" };
        } catch (error: any) {
          logger.error("create_slack_list_item tool failed", { list_id, error: error.message });
          return { ok: false, error: `Failed to create list item: ${error.message}` };
        }
      },
    }),

    update_slack_list_item: tool({
      description:
        "Update fields on an existing item (row) in a Slack List. Use this to change title, status, assignee, severity, etc. " +
        "IMPORTANT: First call get_slack_list_item to see the exact column IDs and value formats. " +
        "Pass each field value in the EXACT same format returned by get_slack_list_item (e.g. rich text arrays, status objects, user arrays).",
      inputSchema: z.object({
        list_id: z.string().describe("The ID of the Slack List"),
        item_id: z.string().describe("The ID of the item/row to update"),
        fields: z
          .record(z.any())
          .describe(
            "Column values to update as a flat object: { column_id: value, ... }. " +
            "Values must use the same format as returned by get_slack_list_item."
          ),
      }),
      execute: async ({ list_id, item_id, fields }) => {
        try {
          await throttle();

          const cells = buildCells(fields, item_id);

          const result = await (client as any).apiCall("slackLists.items.update", {
            list_id,
            cells,
          });

          if (!result.ok) {
            logger.error("update_slack_list_item API error", {
              list_id,
              item_id,
              error: result.error,
              response_metadata: result.response_metadata,
              cells_count: cells.length,
            });
            return {
              ok: false,
              error: `Failed to update list item: ${result.error || "unknown"}`,
              detail: result.response_metadata?.messages?.join("; ") || undefined,
            };
          }

          logger.info("update_slack_list_item tool called", { list_id, item_id, fields_keys: Object.keys(fields) });
          return { ok: true, message: "List item updated" };
        } catch (error: any) {
          logger.error("update_slack_list_item tool failed", { list_id, item_id, error: error.message });
          return { ok: false, error: `Failed to update list item: ${error.message}` };
        }
      },
    }),

    delete_slack_list_item: tool({
      description:
        "Delete an item (row) from a Slack List.",
      inputSchema: z.object({
        list_id: z.string().describe("The ID of the Slack List"),
        item_id: z.string().describe("The ID of the item/row to delete"),
      }),
      execute: async ({ list_id, item_id }) => {
        try {
          await throttle();
          const result = await (client as any).apiCall("slackLists.items.delete", {
            list_id,
            item_id,
          });

          if (!result.ok) {
            return { ok: false, error: `Failed to delete list item: ${result.error || "unknown"}` };
          }

          logger.info("delete_slack_list_item tool called", { list_id, item_id });
          return { ok: true, message: "List item deleted" };
        } catch (error: any) {
          logger.error("delete_slack_list_item tool failed", { list_id, item_id, error: error.message });
          return { ok: false, error: `Failed to delete list item: ${error.message}` };
        }
      },
    }),
  };
}

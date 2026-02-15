import { tool } from "ai";
import { z } from "zod";
import type { WebClient } from "@slack/web-api";
import { logger } from "../lib/logger.js";

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
          .describe("Column values as a JSON object of column_id -> value pairs. Use get_slack_list_item on an existing item to see the column IDs and value formats."),
      }),
      execute: async ({ list_id, fields }) => {
        try {
          const params: any = { list_id };
          if (fields) {
            params.initial_fields = fields;
          }

          const result = await (client as any).apiCall("slackLists.items.create", params);

          if (!result.ok) {
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
        "Update fields on an existing item (row) in a Slack List. Use this to change status, assignee, priority, etc.",
      inputSchema: z.object({
        list_id: z.string().describe("The ID of the Slack List"),
        item_id: z.string().describe("The ID of the item/row to update"),
        fields: z
          .record(z.any())
          .describe("Column values to update as column_id -> value pairs"),
      }),
      execute: async ({ list_id, item_id, fields }) => {
        try {
          // Build the update payload -- each field is a separate column update
          const updates = Object.entries(fields).map(([column_id, value]) => ({
            column_id,
            value,
          }));

          const result = await (client as any).apiCall("slackLists.items.update", {
            list_id,
            row_id: item_id,
            columns: updates,
          });

          if (!result.ok) {
            return { ok: false, error: `Failed to update list item: ${result.error || "unknown"}` };
          }

          logger.info("update_slack_list_item tool called", { list_id, item_id });
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

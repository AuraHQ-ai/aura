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
          .describe(
            "Column values as a JSON object of column_id -> value pairs. " +
              "Use get_slack_list_item on an existing item to see the column IDs and value formats. " +
              "Values must match the exact format returned by get_slack_list_item.",
          ),
      }),
      execute: async ({ list_id, fields }) => {
        try {
          const params: any = { list_id };
          if (fields) {
            params.initial_fields = fields;
          }

          const result = await (client as any).apiCall(
            "slackLists.items.create",
            params,
          );

          if (!result.ok) {
            logger.error("create_slack_list_item API error", {
              list_id,
              error: result.error,
              response_metadata: result.response_metadata,
            });
            return {
              ok: false,
              error: `Failed to create list item: ${result.error || "unknown"}`,
            };
          }

          const created = result.record || result.item;
          logger.info("create_slack_list_item tool called", {
            list_id,
            itemId: created?.id,
          });
          return {
            ok: true,
            item_id: created?.id,
            message: "List item created",
          };
        } catch (error: any) {
          logger.error("create_slack_list_item tool failed", {
            list_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to create list item: ${error.message}`,
          };
        }
      },
    }),

    update_slack_list_item: tool({
      description:
        "Update fields on an existing item (row) in a Slack List. Use this to change title, status, assignee, severity, etc. " +
        "IMPORTANT: First call get_slack_list_item to see the exact column IDs and value formats. " +
        "Values can be: a string (for text fields), an array of strings (for select/status fields like [\"done\"]), " +
        "an array of user IDs (for user fields like [\"U01234\"]), or a typed object like {select: [\"done\"]} for explicit control. " +
        "Date fields MUST use typed objects: {date: [\"2025-09-20\"]}.",
      inputSchema: z.object({
        list_id: z.string().describe("The ID of the Slack List"),
        item_id: z.string().describe("The ID of the item/row to update"),
        fields: z
          .record(z.any())
          .describe(
            "Column values to update as a flat object: { column_id: value, ... }. " +
              "Simple formats: string for text, [\"value\"] for select/status, [\"U01234\"] for users. " +
              "Or use typed objects: {select: [\"done\"]}, {rich_text: [...]}, {user: [\"U01234\"]}, {date: [\"2025-09-20\"]}.",
          ),
      }),
      execute: async ({ list_id, item_id, fields }) => {
        try {

          const TYPED_KEYS = new Set(["select", "rich_text", "user", "date", "timestamp", "number", "attachment"]);

          const cells = Object.entries(fields).map(([column_id, value]) => {
            const base = { column_id, row_id: item_id };

            // Already a typed object with the right Slack API keys — pass through
            if (
              typeof value === "object" &&
              value !== null &&
              !Array.isArray(value) &&
              Object.keys(value).some((k) => TYPED_KEYS.has(k))
            ) {
              return { ...value, ...base };
            }

            // String → rich_text
            if (typeof value === "string") {
              return {
                ...base,
                rich_text: [
                  {
                    type: "rich_text",
                    elements: [
                      {
                        type: "rich_text_section",
                        elements: [{ type: "text", text: value }],
                      },
                    ],
                  },
                ],
              };
            }

            // Number → pass through as number type
            if (typeof value === "number") {
              return { ...base, number: value };
            }

            // Array handling
            if (Array.isArray(value)) {
              // Array of rich_text blocks (first element has type: "rich_text")
              if (value.length > 0 && value[0]?.type === "rich_text") {
                return { ...base, rich_text: value };
              }
              // Array of strings — could be select or user IDs
              // User IDs start with U or W followed by alphanumeric
              if (value.length > 0 && typeof value[0] === "string") {
                if (value.every((v: string) => /^[UW][A-Z0-9]{8,}$/.test(v))) {
                  return { ...base, user: value };
                }
                // Default: treat string arrays as select values
                // (Date fields are handled via typed objects above, per tool description)
                return { ...base, select: value };
              }
            }

            // Fallback: pass value as-is (may fail, but at least we tried the smart path)
            return { ...base, value };
          });

          const result = await (client as any).apiCall(
            "slackLists.items.update",
            {
              list_id,
              cells,
            },
          );

          if (!result.ok) {
            logger.error("update_slack_list_item API error", {
              list_id,
              item_id,
              error: result.error,
              response_metadata: result.response_metadata,
              fields_keys: Object.keys(fields),
            });
            return {
              ok: false,
              error: `Failed to update list item: ${result.error || "unknown"}`,
              detail:
                result.response_metadata?.messages?.join("; ") || undefined,
            };
          }

          logger.info("update_slack_list_item tool called", {
            list_id,
            item_id,
            fields_keys: Object.keys(fields),
          });
          return { ok: true, message: "List item updated" };
        } catch (error: any) {
          logger.error("update_slack_list_item tool failed", {
            list_id,
            item_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to update list item: ${error.message}`,
          };
        }
      },
    }),

    delete_slack_list_item: tool({
      description: "Delete an item (row) from a Slack List.",
      inputSchema: z.object({
        list_id: z.string().describe("The ID of the Slack List"),
        item_id: z.string().describe("The ID of the item/row to delete"),
      }),
      execute: async ({ list_id, item_id }) => {
        try {
          const result = await (client as any).apiCall(
            "slackLists.items.delete",
            {
              list_id,
              id: item_id,
            },
          );

          if (!result.ok) {
            return {
              ok: false,
              error: `Failed to delete list item: ${result.error || "unknown"}`,
            };
          }

          logger.info("delete_slack_list_item tool called", {
            list_id,
            item_id,
          });
          return { ok: true, message: "List item deleted" };
        } catch (error: any) {
          logger.error("delete_slack_list_item tool failed", {
            list_id,
            item_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to delete list item: ${error.message}`,
          };
        }
      },
    }),
  };
}

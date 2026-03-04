import { z } from "zod";
import { defineTool } from "../lib/tool.js";
import { getApiCredentialWithType } from "../lib/api-credentials.js";
import { logger } from "../lib/logger.js";
import type { ScheduleContext } from "../db/schema.js";

/**
 * Create credential tools for the AI SDK.
 * Provides secure retrieval of stored API credentials (tokens, OAuth clients).
 */
export function createCredentialTools(context?: ScheduleContext) {
  return {
    get_credential: defineTool({
      description:
        "Retrieve a stored API credential by name. Returns the decrypted value for 'token' type credentials, or parsed client_id + client_secret for 'oauth_client' type. Permission checks and audit logging are automatic. Use this when a job or workflow needs an API key, token, or OAuth client credentials that the user has stored via the App Home.",
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            "The credential name (lowercase, a-z, 0-9, underscores), e.g. 'airbyte_api_token'",
          ),
        owner_id: z
          .string()
          .optional()
          .describe(
            "The Slack user ID of the credential owner. Defaults to the current user.",
          ),
      }),
      execute: async ({ name, owner_id }) => {
        const requestingUserId = context?.userId;
        if (!requestingUserId) {
          return { ok: false, error: "No user context available." };
        }

        const ownerId = owner_id || requestingUserId;

        try {
          const result = await getApiCredentialWithType(
            name,
            ownerId,
            requestingUserId,
            "read",
          );

          if (!result) {
            return {
              ok: false,
              error: `Credential "${name}" not found or expired.`,
            };
          }

          if (result.type === "oauth_client") {
            try {
              const parsed = JSON.parse(result.value);
              return {
                ok: true,
                type: "oauth_client" as const,
                client_id: parsed.client_id,
                client_secret: parsed.client_secret,
              };
            } catch {
              return {
                ok: false,
                error: `Credential "${name}" has type oauth_client but its value is not valid JSON.`,
              };
            }
          }

          return {
            ok: true,
            type: "token" as const,
            value: result.value,
          };
        } catch (error: any) {
          logger.error("get_credential tool failed", {
            name,
            ownerId,
            error: error.message,
          });
          return { ok: false, error: error.message };
        }
      },
      slack: {
        status: "Retrieving credential...",
      },
    }),
  };
}

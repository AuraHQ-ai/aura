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
        "Retrieve a stored API credential by name. Returns the decrypted value based on auth_scheme (bearer, basic, header, query, oauth_client). For oauth_client, automatically exchanges client credentials for a fresh access token using token_url stored inside the credential value. Permission checks and audit logging are automatic. Use this when a job or workflow needs an API key, token, or OAuth client credentials that the user has stored via the App Home.",
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

          if (result.authScheme === "oauth_client") {
            return {
              ok: true,
              auth_scheme: "oauth_client" as const,
              value: result.value,
            };
          }

          return {
            ok: true,
            auth_scheme: result.authScheme,
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

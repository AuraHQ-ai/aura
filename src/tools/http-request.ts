import dns from "node:dns/promises";
import { z } from "zod";
import { defineTool } from "../lib/tool.js";
import { getApiCredentialWithType } from "../lib/api-credentials.js";
import { logger } from "../lib/logger.js";
import type { ScheduleContext } from "../db/schema.js";

function isPrivateIP(ip: string): boolean {
  return (
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^127\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^0\./.test(ip) ||
    ip === "::1"
  );
}

export function createHttpRequestTool(context?: ScheduleContext) {
  return {
    http_request: defineTool({
      description:
        "Make a credentialed HTTP request to an external API. " +
        "The credential is injected server-side -- the LLM never sees the key value. " +
        "Use this for all external API calls that require stored credentials. " +
        "Specify credential_name (e.g. 'close_fr') and credential_owner (Slack user ID) " +
        "to inject auth. The server resolves the credential from the encrypted store and " +
        "sets the Authorization header. You CANNOT pass Authorization, x-api-key, or " +
        "x-auth-token headers directly -- use credential_name instead.",
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        url: z.string().url(),
        credential_name: z
          .string()
          .optional()
          .describe("Name of the stored credential to inject as Authorization header"),
        credential_owner: z
          .string()
          .optional()
          .describe("Slack user ID of the credential owner"),
        headers: z
          .record(z.string())
          .optional()
          .refine(
            (h) =>
              !h ||
              !Object.keys(h).some((k) =>
                ["authorization", "x-api-key", "x-auth-token"].includes(
                  k.toLowerCase(),
                ),
              ),
            {
              message:
                "Use credential_name to inject auth headers -- direct Authorization header is not allowed",
            },
          )
          .describe("Additional headers (auth headers not allowed -- use credential_name)"),
        body: z.unknown().optional().describe("Request body (will be JSON-serialized)"),
        timeout_ms: z
          .number()
          .default(30_000)
          .describe("Request timeout in milliseconds (default 30s)"),
      }),
      execute: async (input) => {
        try {
          const { hostname } = new URL(input.url);
          const resolved = await dns.resolve4(hostname).catch(() => [] as string[]);
          for (const ip of resolved) {
            if (isPrivateIP(ip)) {
              return {
                ok: false as const,
                error: `Blocked: ${hostname} resolves to private IP ${ip}`,
              };
            }
          }

          const headers: Record<string, string> = { ...input.headers };
          let requestUrl = input.url;

          if (input.credential_name) {
            const owner = input.credential_owner ?? context?.userId;
            if (!owner) {
              return {
                ok: false as const,
                error:
                  "credential_owner is required (or must be running in a user context)",
              };
            }

            const requestingUserId = context?.userId ?? owner;
            const credResult = await getApiCredentialWithType(
              input.credential_name,
              owner,
              requestingUserId,
              "read",
            );

            if (!credResult) {
              return {
                ok: false as const,
                error: `Credential "${input.credential_name}" not found or expired`,
              };
            }

            switch (credResult.authScheme) {
              case "bearer":
              case "oauth_client":
              case "google_service_account": {
                headers["Authorization"] = `Bearer ${credResult.value}`;
                break;
              }
              case "basic": {
                let basicParsed: { username: string; password: string };
                try {
                  basicParsed = JSON.parse(credResult.value);
                } catch {
                  return {
                    ok: false as const,
                    error: "basic credential value must be JSON {username, password}",
                  };
                }
                const encoded = Buffer.from(
                  `${basicParsed.username}:${basicParsed.password}`
                ).toString("base64");
                headers["Authorization"] = `Basic ${encoded}`;
                break;
              }
              case "header": {
                let parsed: { key: string; secret: string };
                try {
                  parsed = JSON.parse(credResult.value);
                } catch {
                  return {
                    ok: false as const,
                    error: `Credential "${input.credential_name}" has auth_scheme header but its value is not valid JSON`,
                  };
                }
                if (!parsed.key || !parsed.secret) {
                  return {
                    ok: false as const,
                    error: `Credential "${input.credential_name}" must include key and secret for header auth`,
                  };
                }
                if (!/^[a-zA-Z0-9\-_]+$/.test(parsed.key)) {
                  return {
                    ok: false as const,
                    error: `Invalid header name "${parsed.key}": must contain only alphanumeric characters, hyphens, and underscores`,
                  };
                }
                headers[parsed.key] = parsed.secret;
                break;
              }
              case "query": {
                // ⚠️ SECURITY WARNING: Query parameter authentication exposes secrets in URLs.
                // Secrets will appear in:
                // - Server access logs
                // - Browser history
                // - CDN/proxy logs
                // - Referer headers when navigating away
                // Use query auth only when required by the API and no better option exists.
                let parsed: { key: string; secret: string };
                try {
                  parsed = JSON.parse(credResult.value);
                } catch {
                  return {
                    ok: false as const,
                    error: `Credential "${input.credential_name}" has auth_scheme query but its value is not valid JSON`,
                  };
                }
                if (!parsed.key || !parsed.secret) {
                  return {
                    ok: false as const,
                    error: `Credential "${input.credential_name}" must include key and secret for query auth`,
                  };
                }
                logger.warn("Using query parameter auth - secrets will be exposed in URL", {
                  credential: input.credential_name,
                  url: input.url,
                });
                const urlObj = new URL(requestUrl);
                urlObj.searchParams.set(parsed.key, parsed.secret);
                requestUrl = urlObj.toString();
                break;
              }
              default:
                return {
                  ok: false as const,
                  error: `Unsupported auth scheme for credential "${input.credential_name}"`,
                };
            }
          }

          if (
            input.body &&
            !Object.keys(headers).some(
              (k) => k.toLowerCase() === "content-type",
            )
          ) {
            headers["Content-Type"] = "application/json";
          }

          logger.info("http_request executing", {
            method: input.method,
            url: input.url,
            hasCredential: !!input.credential_name,
          });

          const response = await fetch(requestUrl, {
            method: input.method,
            headers,
            body: input.body
              ? (typeof input.body === "string" ? input.body : JSON.stringify(input.body))
              : undefined,
            redirect: "manual",
            signal: AbortSignal.timeout(input.timeout_ms),
          });

          let responseBody: unknown;
          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("application/json")) {
            responseBody = await response.json().catch(() => null);
          }
          if (responseBody === undefined || responseBody === null) {
            const text = await response.text().catch(() => "");
            responseBody =
              text.length > 50_000 ? text.slice(0, 50_000) + "... (truncated)" : text;
          }

          return {
            ok: response.ok as boolean,
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: responseBody,
          };
        } catch (error: any) {
          logger.error("http_request failed", { error: error.message, url: input.url });
          return { ok: false as const, error: `Request failed: ${error.message}` };
        }
      },
      slack: {
        status: "Making HTTP request...",
        detail: (input) => `${input.method} ${input.url}`,
        output: (result: any) =>
          result.ok === false && result.error
            ? result.error
            : `HTTP ${result.status}`,
      },
    }),
  };
}

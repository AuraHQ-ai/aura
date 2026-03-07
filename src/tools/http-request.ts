import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { logger } from "../lib/logger.js";
import type { ScheduleContext } from "../db/schema.js";
import type { RiskTier } from "../lib/approval.js";

const METHOD_RISK: Record<string, RiskTier> = {
  GET: "read",
  HEAD: "read",
  OPTIONS: "read",
  POST: "write",
  PUT: "write",
  PATCH: "write",
  DELETE: "destructive",
};

export function createHttpRequestTools(context?: ScheduleContext) {
  return {
    http_request: defineTool({
      description:
        "Make an HTTP request using a stored API credential. The credential value is injected " +
        "as a Bearer token (or via the Authorization header) and NEVER exposed in Aura's context. " +
        "Use this for any API call that requires a user's stored credential. " +
        "Risk tier is determined by HTTP method: GET/HEAD=read, POST/PUT/PATCH=write, DELETE=destructive — " +
        "unless overridden by an approval_policy for this tool. " +
        "Params: method, url, credential_name (matches stored credential name), " +
        "credential_owner (Slack user ID, defaults to the requesting user or job creator), " +
        "body (JSON string for POST/PUT/PATCH), headers (extra headers as key-value object).",
      inputSchema: z.object({
        method: z
          .enum(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"])
          .describe("HTTP method"),
        url: z.string().url().describe("Full URL to call"),
        credential_name: z
          .string()
          .describe(
            "Name of the stored API credential to use for authentication",
          ),
        credential_owner: z
          .string()
          .optional()
          .describe(
            "Slack user ID of the credential owner. Defaults to the requesting user.",
          ),
        body: z
          .string()
          .optional()
          .describe("Request body (JSON string) for POST/PUT/PATCH"),
        headers: z
          .record(z.string())
          .optional()
          .describe("Additional headers as key-value pairs"),
      }),
      risk: "write",
      execute: async ({
        method,
        url,
        credential_name,
        credential_owner,
        body,
        headers: extraHeaders,
      }) => {
        const { withApiCredential } = await import(
          "../lib/api-credentials.js"
        );

        const ownerId = credential_owner || context?.userId || "unknown";
        const requestingUserId = context?.userId || ownerId;

        const methodRisk = METHOD_RISK[method] ?? "write";
        const intent: "read" | "write" =
          methodRisk === "read" ? "read" : "write";

        try {
          const result = await withApiCredential(
            credential_name,
            ownerId,
            requestingUserId,
            intent,
            async (credentialValue: string) => {
              const reqHeaders: Record<string, string> = {
                Authorization: `Bearer ${credentialValue}`,
                ...extraHeaders,
              };

              if (body && !reqHeaders["Content-Type"]) {
                reqHeaders["Content-Type"] = "application/json";
              }

              const resp = await fetch(url, {
                method,
                headers: reqHeaders,
                body: body ?? undefined,
              });

              const respHeaders: Record<string, string> = {};
              resp.headers.forEach((v, k) => {
                respHeaders[k] = v;
              });

              let respBody: any;
              const contentType = resp.headers.get("content-type") || "";
              if (contentType.includes("application/json")) {
                respBody = await resp.json();
              } else {
                const text = await resp.text();
                respBody =
                  text.length > 10000 ? text.slice(0, 10000) + "..." : text;
              }

              return {
                ok: resp.ok,
                status: resp.status,
                statusText: resp.statusText,
                headers: respHeaders,
                body: respBody,
              };
            },
          );

          logger.info("http_request tool called", {
            method,
            url,
            credential_name,
            status: result.status,
          });

          return { ok: true, response: result };
        } catch (error: any) {
          logger.error("http_request tool failed", {
            method,
            url,
            credential_name,
            error: error.message,
          });
          return { ok: false, error: error.message };
        }
      },
      slack: {
        status: "Making API request...",
        detail: (i) => `${i.method} ${i.url}`,
      },
    }),
  };
}

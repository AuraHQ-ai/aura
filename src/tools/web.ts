import { tool } from "ai";
import { z } from "zod";
import { tavily } from "@tavily/core";
import { logger } from "../lib/logger.js";

// ── Tavily Client ────────────────────────────────────────────────────────────

function getTavilyClient() {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  return tavily({ apiKey });
}

// ── HTML Stripping ───────────────────────────────────────────────────────────

/** Strip HTML tags and clean up whitespace for readable text extraction. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

/**
 * Create web tools for the AI SDK.
 */
export function createWebTools() {
  return {
    web_search: tool({
      description:
        "Search the web for current information. Use this when someone asks about external topics, current events, documentation, or anything outside the Slack workspace. Requires TAVILY_API_KEY to be configured.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("The search query, e.g. 'latest Next.js release notes' or 'how to configure pgvector indexes'"),
        max_results: z
          .number()
          .min(1)
          .max(10)
          .default(5)
          .describe("Number of results to return (max 10)"),
      }),
      execute: async ({ query, max_results }) => {
        const tvly = getTavilyClient();
        if (!tvly) {
          return {
            ok: false,
            error: "Web search is not available. TAVILY_API_KEY is not configured.",
          };
        }

        try {
          const response = await tvly.search(query, {
            maxResults: max_results,
            searchDepth: "basic",
            includeAnswer: true,
          });

          const results = (response.results || []).map((r: any) => ({
            title: r.title || "",
            url: r.url || "",
            content: (r.content || "").substring(0, 500),
          }));

          logger.info("web_search tool called", {
            query,
            resultCount: results.length,
          });

          return {
            ok: true,
            query,
            answer: response.answer || null,
            results,
            count: results.length,
          };
        } catch (error: any) {
          logger.error("web_search tool failed", {
            query,
            error: error.message,
          });
          return {
            ok: false,
            error: `Web search failed: ${error.message}`,
          };
        }
      },
    }),

    read_url: tool({
      description:
        "Fetch a URL and extract its readable text content. Use this when someone pastes a link and wants you to read it, or to check if a site is up. If TAVILY_API_KEY is configured, uses Tavily extract for cleaner results; otherwise falls back to basic HTML stripping.",
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe("The URL to fetch and read"),
      }),
      execute: async ({ url }) => {
        try {
          // Try Tavily extract first (cleaner extraction)
          const tvly = getTavilyClient();
          if (tvly) {
            try {
              const response = await tvly.extract([url]);
              const result = response.results?.[0];
              if (result) {
                const content = (result.rawContent || "").substring(0, 4000);
                logger.info("read_url tool called (tavily)", { url, contentLength: content.length });
                return {
                  ok: true,
                  url,
                  content,
                  source: "tavily",
                };
              }
            } catch {
              // Fall through to fetch
            }
          }

          // Fallback: raw fetch + HTML stripping
          const response = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; AuraBot/1.0)",
            },
            signal: AbortSignal.timeout(10000),
          });

          if (!response.ok) {
            return {
              ok: false,
              error: `HTTP ${response.status} ${response.statusText}`,
              url,
            };
          }

          const contentType = response.headers.get("content-type") || "";
          const rawBody = await response.text();

          let content: string;
          if (contentType.includes("text/html")) {
            content = stripHtml(rawBody).substring(0, 4000);
          } else if (contentType.includes("application/json")) {
            content = rawBody.substring(0, 4000);
          } else {
            content = rawBody.substring(0, 4000);
          }

          logger.info("read_url tool called (fetch)", { url, contentLength: content.length });

          return {
            ok: true,
            url,
            content,
            source: "fetch",
          };
        } catch (error: any) {
          logger.error("read_url tool failed", { url, error: error.message });

          if (error.name === "TimeoutError" || error.name === "AbortError") {
            return { ok: false, error: `Request timed out after 10 seconds`, url };
          }

          return {
            ok: false,
            error: `Failed to read URL: ${error.message}`,
            url,
          };
        }
      },
    }),
  };
}

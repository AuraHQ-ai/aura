import { z } from "zod";
import { tavily } from "@tavily/core";
import { logger } from "../lib/logger.js";
import { BROWSER_UA, isPrivateUrl } from "../lib/ssrf.js";
import { defineTool } from "../lib/tool.js";

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
    web_search: defineTool({
      description:
        "Search the web for current information, documentation, news, or anything outside the Slack workspace. Don't search the web for things you can find in the workspace — use search_messages or read_channel_history instead. Requires TAVILY_API_KEY.",
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
            ok: false as const,
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
            ok: true as const,
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
            ok: false as const,
            error: `Web search failed: ${error.message}`,
          };
        }
      },
      slack: {
        status: "Searching the web...",
        detail: (input) => input.query,
        output: (result) => "ok" in result && result.ok ? `${result.count ?? 0} results` : result.error,
        sources: (result) => {
          if (!("ok" in result) || !result.ok || !Array.isArray(result.results)) return undefined;
          return result.results.slice(0, 3).map((r) => ({
            type: "url" as const,
            url: r.url,
            text: r.title || r.url,
          }));
        },
      },
    }),

    read_url: defineTool({
      description:
        "Fetch a URL and extract its readable text content. Use when someone pastes a link and asks 'what does this say?' or 'can you read this?', or to check if a site is up. For simple text extraction, prefer this over browse. If TAVILY_API_KEY is configured, uses Tavily extract for cleaner results; otherwise falls back to basic HTML stripping.",
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe("The URL to fetch and read"),
      }),
      execute: async ({ url }) => {
        try {
          // SSRF guard — block private/internal addresses
          if (await isPrivateUrl(url)) {
            logger.warn("read_url SSRF blocked", { url });
            return {
              ok: false as const,
              error: "Blocked: URL resolves to a private/internal network address",
              url,
            };
          }

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
                  ok: true as const,
                  url,
                  content,
                  source: "tavily" as const,
                };
              }
            } catch {
              // Fall through to fetch
            }
          }

          // Fallback: raw fetch + HTML stripping (manual redirect to re-validate each hop)
          let currentUrl = url;
          let response!: Response;
          for (let r = 0; r < 10; r++) {
            response = await fetch(currentUrl, {
              headers: {
                "User-Agent": BROWSER_UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br",
                "Cache-Control": "no-cache",
              },
              signal: AbortSignal.timeout(10000),
              redirect: "manual",
            });
            if (response.status >= 300 && response.status < 400) {
              const location = response.headers.get("location");
              if (!location) break;
              currentUrl = new URL(location, currentUrl).toString();
              if (await isPrivateUrl(currentUrl)) {
                logger.warn("read_url SSRF blocked (redirect)", { url, redirectTo: currentUrl });
                return {
                  ok: false as const,
                  error: "Blocked: redirect resolves to a private/internal network address",
                  url,
                };
              }
              continue;
            }
            break;
          }

          if (!response.ok) {
            const hint = response.status === 403
              ? ". This may be Cloudflare bot protection — try using the `browse` tool instead, which uses a real browser."
              : "";
            return {
              ok: false as const,
              error: `HTTP ${response.status} ${response.statusText}${hint}`,
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
            ok: true as const,
            url,
            content,
            source: "fetch" as const,
          };
        } catch (error: any) {
          logger.error("read_url tool failed", { url, error: error.message });

          if (error.name === "TimeoutError" || error.name === "AbortError") {
            return { ok: false as const, error: `Request timed out after 10 seconds`, url };
          }

          return {
            ok: false as const,
            error: `Failed to read URL: ${error.message}`,
            url,
          };
        }
      },
      slack: {
        status: "Reading a link...",
        detail: (input) => input.url,
        output: (result) => {
          if ("ok" in result && !result.ok) return result.error;
          return undefined;
        },
        sources: (result) => {
          if (!("ok" in result) || !result.ok || !("url" in result)) return undefined;
          const url = (result as { url: string }).url;
          try {
            return [{ type: "url" as const, url, text: new URL(url).hostname }];
          } catch {
            return [{ type: "url" as const, url, text: url }];
          }
        },
      },
    }),
  };
}

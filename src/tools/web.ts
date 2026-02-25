import { z } from "zod";
import { tavily } from "@tavily/core";
import { lookup } from "node:dns/promises";
import { logger } from "../lib/logger.js";
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

// ── SSRF Protection ──────────────────────────────────────────────────────────

/**
 * Returns true if the URL resolves to a private/internal network address.
 * Fails closed: if DNS lookup fails, the URL is considered private (blocked).
 */
async function isPrivateUrl(url: string): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return true; // unparseable URL — block it
  }

  // Strip IPv6 brackets for comparison
  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  // Block known-private hostnames immediately (no DNS needed)
  if (
    bare === "localhost" ||
    bare === "0.0.0.0" ||
    bare === "::1" ||
    bare.endsWith(".local") ||
    bare.endsWith(".internal")
  ) {
    return true;
  }

  // Resolve hostname → IP and check against private ranges
  let address: string;
  let family: number;
  try {
    ({ address, family } = await lookup(bare));
  } catch {
    return true; // DNS failure — fail closed
  }

  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:x.x.x.x) — extract and validate as IPv4
    const v4Mapped = address.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (v4Mapped) {
      address = v4Mapped[1];
    } else {
      if (address === "::1") return true;                          // loopback
      const firstWord = parseInt(address.split(":")[0], 16);
      if (firstWord >= 0xfe80 && firstWord <= 0xfebf) return true; // link-local (fe80::/10)
      if (address.toLowerCase().startsWith("fc") ||
          address.toLowerCase().startsWith("fd")) return true;     // ULA (fc00::/7)
      return false;
    }
  }

  // IPv4: parse octets and check private ranges
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return true;
  const [a, b] = parts;

  if (a === 127) return true;                        // 127.0.0.0/8  loopback
  if (a === 10) return true;                         // 10.0.0.0/8   RFC-1918
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 RFC-1918
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16 RFC-1918
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local
  if (a === 0) return true;                          // 0.0.0.0/8

  return false;
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
                "User-Agent": "Mozilla/5.0 (compatible; AuraBot/1.0)",
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
            return {
              ok: false as const,
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

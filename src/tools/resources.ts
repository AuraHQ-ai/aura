import { z } from "zod";
import { generateText } from "ai";
import crypto from "node:crypto";
import { eq, and, sql, desc } from "drizzle-orm";
import { defineTool } from "../lib/tool.js";
import { db } from "../db/client.js";
import { resources } from "../db/schema.js";
import type { ScheduleContext } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { embedText } from "../lib/embeddings.js";
import { getFastModel } from "../lib/ai.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/** Truncate text to roughly `maxChars` on a word boundary. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf(" ", maxChars);
  return text.substring(0, cut > 0 ? cut : maxChars) + "…";
}

/** Guess source type from URL if not explicitly provided. */
function inferSource(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("youtube.com") || host.includes("youtu.be"))
      return "youtube";
    if (host.includes("notion.so") || host.includes("notion.site"))
      return "notion";
    if (host.includes("github.com")) return "github";
    if (
      host.includes("docs.") ||
      host.includes("developer.") ||
      host.includes("devdocs.")
    )
      return "docs";
    return "web";
  } catch {
    return "web";
  }
}

async function fetchUrlContent(
  url: string,
): Promise<{ content: string; title?: string }> {
  const BROWSER_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  const tavilyKey = process.env.TAVILY_API_KEY;
  if (tavilyKey) {
    try {
      const { tavily } = await import("@tavily/core");
      const tvly = tavily({ apiKey: tavilyKey });
      const response = await tvly.extract([url]);
      const result = response.results?.[0];
      if (result?.rawContent) {
        return { content: result.rawContent };
      }
    } catch {
      // fall through to fetch
    }
  }

  let currentUrl = url;
  let response!: Response;
  for (let r = 0; r < 10; r++) {
    response = await fetch(currentUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    break;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const rawBody = await response.text();
  const contentType = response.headers.get("content-type") || "";

  let content: string;
  if (contentType.includes("text/html")) {
    content = rawBody
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
  } else {
    content = rawBody;
  }

  const titleMatch = rawBody.match(/<title[^>]*>(.*?)<\/title>/i);
  return { content, title: titleMatch?.[1]?.trim() };
}

async function generateSummary(
  content: string,
  title?: string,
  url?: string,
): Promise<string> {
  const model = await getFastModel();
  const preview = truncate(content, 12000);
  const result = await generateText({
    model,
    system:
      "You are a concise summarizer. Generate a ~200 word summary of the provided content. Focus on the key topics, findings, and takeaways. Write in third person. Do not use phrases like 'this document' or 'the article'. Just state the content directly.",
    prompt: `${title ? `Title: ${title}\n` : ""}${url ? `URL: ${url}\n` : ""}\n---\n\n${preview}`,
    maxOutputTokens: 400,
  });
  return result.text.trim();
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

export function createResourceTools(context?: ScheduleContext) {
  return {
    ingest_resource: defineTool({
      description:
        "Ingest a URL into the resources knowledge base. Fetches content, converts to markdown, generates a summary + embedding. Idempotent: re-ingesting the same URL skips processing if content hasn't changed (based on SHA-256 hash). Use for YouTube videos, Notion pages, docs, GitHub files, blog posts, or any web content you want to store for later retrieval. Pass `content` directly if you already have the text (e.g. from a transcript or API response) — skips the fetch step.",
      inputSchema: z.object({
        url: z.string().describe("The URL that uniquely identifies this resource"),
        source: z
          .string()
          .optional()
          .describe(
            "Source type: 'youtube', 'notion', 'github', 'web', 'docs'. Auto-detected from URL if omitted.",
          ),
        title: z.string().optional().describe("Title of the resource"),
        parent_url: z
          .string()
          .optional()
          .describe(
            "Parent resource URL for hierarchy (e.g. repo URL for a file, parent page for a Notion child)",
          ),
        content: z
          .string()
          .optional()
          .describe(
            "Pre-fetched content in markdown. If provided, skips URL fetching. Use when you already have the text (transcripts, API responses, etc.)",
          ),
        metadata: z
          .record(z.any())
          .optional()
          .describe(
            "Flexible metadata object (e.g. { channel: 'YouTube', duration: '45:00', author: 'Boris Cherny' })",
          ),
      }),
      execute: async ({ url, source, title, parent_url, content, metadata }) => {
        try {
          const effectiveSource = source || inferSource(url);

          const existing = await db
            .select({
              id: resources.id,
              contentHash: resources.contentHash,
              status: resources.status,
            })
            .from(resources)
            .where(eq(resources.url, url))
            .limit(1);

          let fetchedContent: string;
          let fetchedTitle = title;

          if (content) {
            fetchedContent = content;
          } else {
            const fetched = await fetchUrlContent(url);
            fetchedContent = fetched.content;
            if (!fetchedTitle && fetched.title) {
              fetchedTitle = fetched.title;
            }
          }

          if (!fetchedContent || fetchedContent.trim().length === 0) {
            if (existing[0]) {
              await db
                .update(resources)
                .set({
                  status: "error",
                  errorMessage: "Fetched content was empty",
                  updatedAt: new Date(),
                })
                .where(eq(resources.url, url));
            } else {
              await db.insert(resources).values({
                url,
                source: effectiveSource,
                parentUrl: parent_url,
                title: fetchedTitle,
                status: "error",
                errorMessage: "Fetched content was empty",
                metadata: metadata || {},
              });
            }
            return { ok: false, error: "Fetched content was empty" };
          }

          const hash = sha256(fetchedContent);

          if (
            existing[0] &&
            existing[0].contentHash === hash &&
            existing[0].status === "ready"
          ) {
            return {
              ok: true,
              message: `Resource already up-to-date (hash match)`,
              url,
              skipped: true,
            };
          }

          const summary = await generateSummary(
            fetchedContent,
            fetchedTitle,
            url,
          );
          const embedding = await embedText(summary);
          const now = new Date();

          if (existing[0]) {
            await db
              .update(resources)
              .set({
                title: fetchedTitle || undefined,
                source: effectiveSource,
                parentUrl: parent_url ?? undefined,
                status: "ready",
                content: fetchedContent,
                summary,
                metadata: metadata || {},
                embedding,
                contentHash: hash,
                errorMessage: null,
                crawledAt: now,
                updatedAt: now,
              })
              .where(eq(resources.url, url));
          } else {
            await db.insert(resources).values({
              url,
              parentUrl: parent_url,
              title: fetchedTitle,
              source: effectiveSource,
              status: "ready",
              content: fetchedContent,
              summary,
              metadata: metadata || {},
              embedding,
              contentHash: hash,
              crawledAt: now,
            });
          }

          logger.info("ingest_resource completed", {
            url,
            source: effectiveSource,
            contentLength: fetchedContent.length,
            isUpdate: !!existing[0],
          });

          return {
            ok: true,
            message: `Resource ingested (${effectiveSource}, ${fetchedContent.length} chars, summary ${summary.length} chars)`,
            url,
            title: fetchedTitle || null,
            source: effectiveSource,
            skipped: false,
          };
        } catch (error: any) {
          logger.error("ingest_resource failed", {
            url,
            error: error.message,
          });

          try {
            await db
              .insert(resources)
              .values({
                url,
                source: source || inferSource(url),
                parentUrl: parent_url,
                title,
                status: "error",
                errorMessage: error.message,
                metadata: metadata || {},
              })
              .onConflictDoUpdate({
                target: resources.url,
                set: {
                  status: "error",
                  errorMessage: error.message,
                  updatedAt: new Date(),
                },
              });
          } catch {
            // best effort
          }

          return {
            ok: false,
            error: `Ingestion failed: ${error.message}`,
          };
        }
      },
      slack: {
        status: "Ingesting resource...",
        detail: (i) => i.url,
        output: (r) => ("ok" in r && r.ok ? r.message : undefined),
      },
    }),

    search_resources: defineTool({
      description:
        "Search the resources knowledge base. Supports two modes: 'semantic' (default) uses vector similarity on resource summaries for conceptual search; 'text' uses Postgres full-text search on the full content for exact keyword matches. Filter by source type (youtube, notion, github, web, docs). Only returns resources with status 'ready'. Use this to find ingested content — YouTube videos, docs, Notion pages, web articles, etc.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Search query — a question, topic, or keywords"),
        mode: z
          .enum(["semantic", "text"])
          .default("semantic")
          .describe(
            "Search mode: 'semantic' (vector similarity on summaries) or 'text' (full-text on content)",
          ),
        source: z
          .string()
          .optional()
          .describe(
            "Filter by source type: 'youtube', 'notion', 'github', 'web', 'docs'",
          ),
        limit: z
          .number()
          .min(1)
          .max(25)
          .default(10)
          .describe("Max results (default 10)"),
      }),
      execute: async ({ query, mode, source, limit }) => {
        try {
          const trimmed = query.trim();
          if (!trimmed) {
            return { ok: false, error: "Query cannot be empty." };
          }

          if (mode === "semantic") {
            const queryEmbedding = await embedText(trimmed);
            const embeddingLiteral = JSON.stringify(queryEmbedding);

            const conditions = [
              sql`${resources.embedding} IS NOT NULL`,
              eq(resources.status, "ready"),
            ];
            if (source) {
              conditions.push(eq(resources.source, source));
            }

            const results = await db
              .select({
                url: resources.url,
                title: resources.title,
                source: resources.source,
                summary: resources.summary,
                crawledAt: resources.crawledAt,
                similarity:
                  sql<number>`1 - (${resources.embedding} <=> ${embeddingLiteral}::vector)`.as(
                    "similarity",
                  ),
              })
              .from(resources)
              .where(and(...conditions))
              .orderBy(
                sql`${resources.embedding} <=> ${embeddingLiteral}::vector`,
              )
              .limit(limit);

            logger.info("search_resources (semantic)", {
              query: trimmed,
              source,
              count: results.length,
            });

            return {
              ok: true,
              mode: "semantic",
              results: results.map((r) => ({
                url: r.url,
                title: r.title,
                source: r.source,
                summary: truncate(r.summary || "", 300),
                crawled_at: r.crawledAt?.toISOString() || null,
                similarity: Math.round(r.similarity * 1000) / 1000,
              })),
              count: results.length,
            };
          }

          // mode === "text"
          const sourceFilter = source
            ? sql`AND source = ${source}`
            : sql``;

          const rows: any[] = await db
            .execute(
              sql`
              SELECT url, title, source, summary, crawled_at,
                ts_headline('english', coalesce(content, ''),
                  websearch_to_tsquery('english', ${trimmed}),
                  'StartSel=>>>, StopSel=<<<, MaxWords=35, MinWords=15'
                ) as snippet,
                ts_rank(
                  to_tsvector('english', coalesce(content, '')),
                  websearch_to_tsquery('english', ${trimmed})
                ) as rank
              FROM resources
              WHERE to_tsvector('english', coalesce(content, ''))
                @@ websearch_to_tsquery('english', ${trimmed})
                AND status = 'ready'
                ${sourceFilter}
              ORDER BY rank DESC
              LIMIT ${limit}
            `,
            )
            .then((r: any) => r.rows ?? r);

          logger.info("search_resources (text)", {
            query: trimmed,
            source,
            count: rows.length,
          });

          return {
            ok: true,
            mode: "text",
            results: rows.map((r: any) => ({
              url: r.url,
              title: r.title,
              source: r.source,
              summary: r.summary
                ? truncate(r.summary, 200)
                : undefined,
              snippet: r.snippet,
              crawled_at: r.crawled_at || null,
            })),
            count: rows.length,
          };
        } catch (error: any) {
          logger.error("search_resources failed", {
            error: error.message,
          });
          return {
            ok: false,
            error: `Search failed: ${error.message}`,
          };
        }
      },
      slack: {
        status: "Searching resources...",
        detail: (i) => i.query,
        output: (r) =>
          "ok" in r && r.ok ? `${r.count} results` : undefined,
      },
    }),

    get_resource: defineTool({
      description:
        "Retrieve the full content of a resource by URL. Returns everything: content, summary, metadata, crawl info. Use after search_resources to load the full text of a specific resource.",
      inputSchema: z.object({
        url: z.string().describe("The URL of the resource to retrieve"),
      }),
      execute: async ({ url }) => {
        try {
          const rows = await db
            .select({
              url: resources.url,
              parentUrl: resources.parentUrl,
              title: resources.title,
              source: resources.source,
              status: resources.status,
              content: resources.content,
              summary: resources.summary,
              metadata: resources.metadata,
              contentHash: resources.contentHash,
              errorMessage: resources.errorMessage,
              crawledAt: resources.crawledAt,
              createdAt: resources.createdAt,
              updatedAt: resources.updatedAt,
            })
            .from(resources)
            .where(eq(resources.url, url))
            .limit(1);

          if (!rows[0]) {
            return {
              ok: false,
              error: `No resource found with URL "${url}". Use search_resources to find it first.`,
            };
          }

          const r = rows[0];

          logger.info("get_resource", {
            url,
            contentLength: r.content?.length ?? 0,
          });

          return {
            ok: true,
            url: r.url,
            parent_url: r.parentUrl,
            title: r.title,
            source: r.source,
            status: r.status,
            content: r.content,
            summary: r.summary,
            metadata: r.metadata,
            content_hash: r.contentHash,
            error_message: r.errorMessage,
            crawled_at: r.crawledAt?.toISOString() || null,
            created_at: r.createdAt.toISOString(),
            updated_at: r.updatedAt.toISOString(),
          };
        } catch (error: any) {
          logger.error("get_resource failed", {
            url,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to get resource: ${error.message}`,
          };
        }
      },
      slack: {
        status: "Loading resource...",
        detail: (i) => i.url,
      },
    }),

    list_resources: defineTool({
      description:
        "List resources in the knowledge base. Optionally filter by source type. Returns URL, title, source, summary preview, and crawl date. Useful for browsing what's been ingested.",
      inputSchema: z.object({
        source: z
          .string()
          .optional()
          .describe(
            "Filter by source type: 'youtube', 'notion', 'github', 'web', 'docs'",
          ),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe("Max results (default 20)"),
      }),
      execute: async ({ source, limit }) => {
        try {
          const conditions = [eq(resources.status, "ready")];
          if (source) {
            conditions.push(eq(resources.source, source));
          }

          const rows = await db
            .select({
              url: resources.url,
              title: resources.title,
              source: resources.source,
              summary: resources.summary,
              crawledAt: resources.crawledAt,
              parentUrl: resources.parentUrl,
            })
            .from(resources)
            .where(and(...conditions))
            .orderBy(desc(resources.crawledAt))
            .limit(limit);

          logger.info("list_resources", {
            source,
            count: rows.length,
          });

          return {
            ok: true,
            resources: rows.map((r) => ({
              url: r.url,
              title: r.title,
              source: r.source,
              summary: r.summary
                ? truncate(r.summary, 150)
                : null,
              parent_url: r.parentUrl,
              crawled_at: r.crawledAt?.toISOString() || null,
            })),
            count: rows.length,
          };
        } catch (error: any) {
          logger.error("list_resources failed", {
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to list resources: ${error.message}`,
          };
        }
      },
      slack: {
        status: "Listing resources...",
        output: (r) =>
          "ok" in r && r.ok ? `${r.count} resources` : undefined,
      },
    }),
  };
}

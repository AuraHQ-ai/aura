import { createHash } from "node:crypto";
import TurndownService from "turndown";
import { generateText } from "ai";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { resources } from "@aura/db/schema";
import type { ScheduleContext } from "@aura/db/schema";
import { getFastModel } from "../lib/ai.js";
import { embedText } from "../lib/embeddings.js";
import { logger } from "../lib/logger.js";
import { tavily } from "@tavily/core";
import { BROWSER_UA, isPrivateUrl } from "../lib/ssrf.js";
import { defineTool } from "../lib/tool.js";
import { formatTimestamp } from "../lib/temporal.js";

function getTavilyClient() {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  return tavily({ apiKey });
}

const RESOURCE_SOURCES = ["youtube", "notion", "github", "web", "docs", "pdf", "slack"] as const;
type ResourceSource = (typeof RESOURCE_SOURCES)[number];

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
turndown.remove(["style", "script", "head"]);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeMetadata(
  existing: unknown,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base = isObjectRecord(existing) ? existing : {};
  return { ...base, ...(incoming ?? {}) };
}

function normalizeMarkdown(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const raw = match[1]
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
  return raw || null;
}

function deriveTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const lastPath = parsed.pathname
      .split("/")
      .filter(Boolean)
      .at(-1);
    return lastPath || parsed.hostname || url;
  } catch {
    return url;
  }
}

function inferSourceFromUrl(url: string): ResourceSource {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes("youtube.com") || host.includes("youtu.be")) return "youtube";
    if (host.includes("notion.so") || host.includes("notion.site")) return "notion";
    if (host === "github.com" || host.endsWith(".github.com")) return "github";
    if (host.startsWith("docs.") || parsed.pathname.includes("/docs/")) return "docs";
    return "web";
  } catch {
    return "web";
  }
}

function isLikelyTextContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("text/") ||
    ct.includes("json") ||
    ct.includes("xml") ||
    ct.includes("javascript") ||
    ct.includes("typescript") ||
    ct.includes("yaml") ||
    ct.includes("graphql")
  );
}

async function fetchUrlAsMarkdown(url: string): Promise<{
  markdown: string;
  title: string | null;
  resolvedUrl: string;
  contentType: string;
}> {
  if (await isPrivateUrl(url)) {
    throw new Error(
      "Blocked: URL resolves to a private/internal network address",
    );
  }

  let currentUrl = url;
  let response!: Response;
  for (let r = 0; r < 10; r++) {
    response = await fetch(currentUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      currentUrl = new URL(location, currentUrl).toString();
      if (await isPrivateUrl(currentUrl)) {
        throw new Error(
          "Blocked: redirect resolves to a private/internal network address",
        );
      }
      continue;
    }
    break;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const rawBody = await response.text();

  if (!rawBody.trim()) {
    throw new Error("Fetched content is empty");
  }

  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    const html = rawBody
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    const markdown = normalizeMarkdown(turndown.turndown(html));
    return {
      markdown,
      title: extractHtmlTitle(rawBody),
      resolvedUrl: currentUrl,
      contentType,
    };
  }

  if (!isLikelyTextContentType(contentType)) {
    throw new Error(
      `Unsupported content type "${contentType || "unknown"}". Provide content_markdown for binaries (e.g. PDFs) after external extraction.`,
    );
  }

  const markdown =
    contentType.includes("json") || contentType.includes("xml")
      ? `\`\`\`\n${rawBody.trim()}\n\`\`\``
      : normalizeMarkdown(rawBody);

  return {
    markdown,
    title: null,
    resolvedUrl: currentUrl,
    contentType,
  };
}

async function summarizeResource(input: {
  url: string;
  title: string | null;
  source: string;
  content: string;
}): Promise<string> {
  const model = await getFastModel();
  const maxChars = 24_000;
  const boundedContent =
    input.content.length > maxChars
      ? `${input.content.slice(0, maxChars)}\n\n[content truncated for summarization]`
      : input.content;

  const { text } = await generateText({
    model,
    maxOutputTokens: 320,
    prompt: `Summarize this resource in ~200 words for fast retrieval.

Focus on:
- what this resource is
- key entities, concepts, and decisions
- actionable takeaways
- notable constraints, dates, or identifiers

Source: ${input.source}
URL: ${input.url}
Title: ${input.title ?? "(unknown)"}

Resource content:
${boundedContent}`,
  });

  const summary = text.trim();
  if (!summary) {
    throw new Error("Summary generation returned empty output");
  }
  return summary;
}

interface ResourceSearchRow {
  url: string;
  title: string | null;
  source: string;
  summary: string | null;
  crawled_at: Date | null;
  snippet?: string | null;
  similarity?: number;
  rank?: number;
}

interface ResourceListRow {
  url: string;
  title: string | null;
  source: string;
  summary: string | null;
  parent_url: string | null;
  crawled_at: Date | null;
}

export function createResourceTools(context?: ScheduleContext) {
  return {
    ingest_resource: defineTool({
      description:
        "Register or refresh a raw source document by URL. Use this for large external material (YouTube transcripts, Notion pages, GitHub files, docs pages, competitor pages) that should live as first-class resources, not notes. The tool stores markdown content, generates a summary, computes a summary embedding, and marks the resource as ready. Idempotent by URL + content hash. For binaries/non-HTTP sources, provide content_markdown directly.",
      inputSchema: z.object({
        url: z
          .string()
          .min(1)
          .describe(
            "Canonical identifier for the resource. Usually an https URL; non-HTTP identifiers like notion://page-id or gs://... are allowed if content_markdown is provided.",
          ),
        source: z
          .enum(RESOURCE_SOURCES)
          .optional()
          .describe(
            "Source type. Optional; inferred from URL when omitted. One of: youtube, notion, github, web, docs, pdf, slack.",
          ),
        parent_url: z
          .string()
          .optional()
          .describe(
            "Optional parent resource URL for hierarchy (e.g., file -> repo, notion child -> parent).",
          ),
        title: z
          .string()
          .optional()
          .describe("Optional title override."),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe("Flexible source-specific metadata to store on the resource."),
        content_markdown: z
          .string()
          .optional()
          .describe(
            "Optional pre-extracted markdown content. Provide this for binaries or non-HTTP URLs; if omitted, Aura fetches the URL and converts it to markdown.",
          ),
        use_tavily: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, try Tavily extract first for cleaner markdown from JS-heavy/SPA pages, then fall back to raw fetch. Requires TAVILY_API_KEY. Default false.",
          ),
      }),
      execute: async ({
        url,
        source,
        parent_url,
        title,
        metadata,
        content_markdown,
        use_tavily,
      }) => {
        const normalizedUrl = url.trim();
        if (!normalizedUrl) {
          return { ok: false, error: "URL cannot be empty." };
        }

        const now = new Date();
        let resolvedSource: ResourceSource = source ?? inferSourceFromUrl(normalizedUrl);

        try {
          const currentRows = await db
            .select({
              id: resources.id,
              url: resources.url,
              title: resources.title,
              source: resources.source,
              status: resources.status,
              parentUrl: resources.parentUrl,
              metadata: resources.metadata,
              contentHash: resources.contentHash,
            })
            .from(resources)
            .where(eq(resources.url, normalizedUrl))
            .limit(1);
          const current = currentRows[0];

          resolvedSource =
            source ?? (current?.source as ResourceSource | undefined) ?? inferSourceFromUrl(normalizedUrl);
          const mergedMetadata = mergeMetadata(current?.metadata, metadata);

          const nextParentUrl = parent_url ?? current?.parentUrl ?? null;
          let nextTitle = title?.trim() || current?.title || null;

          if (/^https?:\/\//i.test(normalizedUrl) && await isPrivateUrl(normalizedUrl)) {
            return { ok: false, error: "Blocked: URL resolves to a private/internal network address" };
          }

          await db
            .insert(resources)
            .values({
              url: normalizedUrl,
              parentUrl: nextParentUrl,
              title: nextTitle,
              source: resolvedSource,
              status: "pending",
              metadata: mergedMetadata,
              errorMessage: null,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: resources.url,
              set: {
                parentUrl: nextParentUrl,
                title: nextTitle,
                source: resolvedSource,
                status: "pending",
                metadata: mergedMetadata,
                errorMessage: null,
                updatedAt: now,
              },
            });

          let content = normalizeMarkdown(content_markdown ?? "");
          const ingestMetadata = { ...mergedMetadata } as Record<string, unknown>;

          if (!content) {
            if (!/^https?:\/\//i.test(normalizedUrl)) {
              throw new Error(
                "content_markdown is required for non-HTTP URLs.",
              );
            }

            let tavilySucceeded = false;
            if (use_tavily) {
              const tvly = getTavilyClient();
              if (tvly) {
                try {
                  const response = await tvly.extract([normalizedUrl]);
                  const result = response.results?.[0];
                  if (result?.rawContent) {
                    content = normalizeMarkdown(result.rawContent);
                    ingestMetadata.extract_source = "tavily";
                    tavilySucceeded = true;
                  }
                } catch (err) {
                  logger.warn("ingest_resource tavily extract failed, falling back to fetch", {
                    url: normalizedUrl,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }

            if (!tavilySucceeded) {
              const fetched = await fetchUrlAsMarkdown(normalizedUrl);
              content = fetched.markdown;
              if (!nextTitle && fetched.title) nextTitle = fetched.title;
              ingestMetadata.resolved_url = fetched.resolvedUrl;
              ingestMetadata.content_type = fetched.contentType;
            }
          }

          if (!content) {
            throw new Error("Resource content is empty after normalization.");
          }

          const contentHash = sha256(content);
          const unchanged =
            current?.status === "ready" && current.contentHash === contentHash;

          if (unchanged) {
            await db
              .update(resources)
              .set({
                parentUrl: nextParentUrl,
                title: nextTitle ?? deriveTitleFromUrl(normalizedUrl),
                source: resolvedSource,
                status: "ready",
                metadata: ingestMetadata,
                errorMessage: null,
                crawledAt: now,
                updatedAt: now,
              })
              .where(eq(resources.url, normalizedUrl));

            logger.info("ingest_resource unchanged", {
              url: normalizedUrl,
              source: resolvedSource,
            });

            return {
              ok: true,
              url: normalizedUrl,
              source: resolvedSource,
              status: "ready",
              unchanged: true,
              crawled_at: now.toISOString(),
            };
          }

          const finalTitle = nextTitle ?? deriveTitleFromUrl(normalizedUrl);
          const summary = await summarizeResource({
            url: normalizedUrl,
            title: finalTitle,
            source: resolvedSource,
            content,
          });
          const embedding = await embedText(summary);

          await db
            .update(resources)
            .set({
              parentUrl: nextParentUrl,
              title: finalTitle,
              source: resolvedSource,
              status: "ready",
              content,
              summary,
              metadata: ingestMetadata,
              embedding,
              contentHash,
              errorMessage: null,
              crawledAt: now,
              updatedAt: now,
            })
            .where(eq(resources.url, normalizedUrl));

          logger.info("ingest_resource tool called", {
            url: normalizedUrl,
            source: resolvedSource,
            contentLength: content.length,
            summaryLength: summary.length,
          });

          return {
            ok: true,
            url: normalizedUrl,
            title: finalTitle,
            source: resolvedSource,
            status: "ready",
            unchanged: false,
            content_length: content.length,
            summary_length: summary.length,
            crawled_at: now.toISOString(),
          };
        } catch (error: any) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          await db
            .update(resources)
            .set({
              source: resolvedSource,
              status: "error",
              errorMessage,
              crawledAt: now,
              updatedAt: now,
            })
            .where(eq(resources.url, normalizedUrl));

          logger.error("ingest_resource tool failed", {
            url: normalizedUrl,
            source: resolvedSource,
            error: errorMessage,
          });

          return {
            ok: false,
            error: `Failed to ingest resource: ${errorMessage}`,
            url: normalizedUrl,
          };
        }
      },
      slack: { status: "Ingesting resource...", detail: (i) => i.url },
    }),

    search_resources: defineTool({
      description:
        "Search ingested resources (status=ready). Use mode='semantic' for conceptual discovery across resource summaries, and mode='text' for exact keyword/full-text search within full markdown content. Optionally filter by source. Returns resource-level matches with URL, title, source, summary, crawl time, and score.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Query text used for semantic or text search."),
        mode: z
          .enum(["text", "semantic"])
          .default("semantic")
          .describe(
            "Search mode: semantic (vector on summary embedding) or text (Postgres full-text on content). Default semantic.",
          ),
        source: z
          .enum(RESOURCE_SOURCES)
          .optional()
          .describe("Optional source filter."),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe("Max results to return (default 10, max 50)."),
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
              eq(resources.status, "ready"),
              sql`${resources.embedding} IS NOT NULL`,
            ];
            if (source) conditions.push(eq(resources.source, source));

            const where = and(...conditions);
            const results = await db.execute(sql`
              SELECT url, title, source, summary, crawled_at,
                     1 - (embedding <=> ${embeddingLiteral}::vector) as similarity
              FROM resources
              WHERE ${where}
              ORDER BY embedding <=> ${embeddingLiteral}::vector
              LIMIT ${limit}
            `);
            const rows = ((results as any).rows ?? results) as ResourceSearchRow[];

            logger.info("search_resources tool called (semantic)", {
              query: trimmed,
              source,
              resultCount: rows.length,
            });

            return {
              ok: true,
              mode: "semantic",
              count: rows.length,
              results: rows.map((r) => ({
                url: r.url,
                title: r.title,
                source: r.source,
                summary: r.summary,
                crawled_at: r.crawled_at
                  ? formatTimestamp(r.crawled_at, context?.timezone)
                  : null,
                similarity: r.similarity != null
                  ? Math.round(Number(r.similarity) * 1000) / 1000
                  : null,
              })),
            };
          }

          const conditions = [eq(resources.status, "ready")];
          if (source) conditions.push(eq(resources.source, source));
          const where = and(...conditions);

          let rows: ResourceSearchRow[] = [];
          try {
            const results = await db.execute(sql`
              SELECT url, title, source, summary, crawled_at,
                     ts_headline(
                       'english',
                       coalesce(content, ''),
                       websearch_to_tsquery('english', ${trimmed}),
                       'StartSel=>>>, StopSel=<<<, MaxWords=35, MinWords=15'
                     ) as snippet,
                     ts_rank(
                       to_tsvector('english', coalesce(content, '')),
                       websearch_to_tsquery('english', ${trimmed})
                     ) as rank
              FROM resources
              WHERE ${where}
                AND to_tsvector('english', coalesce(content, ''))
                    @@ websearch_to_tsquery('english', ${trimmed})
              ORDER BY rank DESC, crawled_at DESC
              LIMIT ${limit}
            `);
            rows = ((results as any).rows ?? results) as ResourceSearchRow[];
          } catch (err: any) {
            const code = typeof err?.code === "string" ? err.code : "";
            if (code && !code.startsWith("42") && !code.startsWith("22")) {
              throw err;
            }
            logger.warn("tsvector search failed, falling back to ILIKE", {
              error: err instanceof Error ? err.message : String(err),
            });
            const escaped = trimmed.replace(/[\\%_]/g, "\\$&");
            const pattern = `%${escaped.toLowerCase()}%`;
            const results = await db.execute(sql`
              SELECT url, title, source, summary, crawled_at,
                     substring(
                       coalesce(content, '')
                       from greatest(1, position(lower(${trimmed}) in lower(coalesce(content, ''))) - 100)
                       for 220
                     ) as snippet
              FROM resources
              WHERE ${where}
                AND lower(coalesce(content, '')) LIKE ${pattern} ESCAPE '\\'
              ORDER BY crawled_at DESC
              LIMIT ${limit}
            `);
            rows = ((results as any).rows ?? results) as ResourceSearchRow[];
          }

          logger.info("search_resources tool called (text)", {
            query: trimmed,
            source,
            resultCount: rows.length,
          });

          return {
            ok: true,
            mode: "text",
            count: rows.length,
            results: rows.map((r) => ({
              url: r.url,
              title: r.title,
              source: r.source,
              summary: r.summary,
              snippet: r.snippet ?? null,
              crawled_at: r.crawled_at
                ? formatTimestamp(r.crawled_at, context?.timezone)
                : null,
              score: r.rank != null ? Math.round(Number(r.rank) * 1000) / 1000 : null,
            })),
          };
        } catch (error: any) {
          logger.error("search_resources tool failed", {
            query,
            mode,
            source,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to search resources: ${error.message}`,
          };
        }
      },
      slack: { status: "Searching resources...", detail: (i) => i.query },
    }),

    get_resource: defineTool({
      description:
        "Retrieve a single resource by URL, including full markdown content, summary, metadata, status, and crawl/error fields. Use this when you need the complete source material after search_resources identifies a match.",
      inputSchema: z.object({
        url: z
          .string()
          .min(1)
          .describe("Exact resource URL (the canonical ID used at ingest time)."),
      }),
      execute: async ({ url }) => {
        try {
          const normalizedUrl = url.trim();
          if (!normalizedUrl) {
            return { ok: false, error: "URL cannot be empty." };
          }

          const rows = await db
            .select()
            .from(resources)
            .where(eq(resources.url, normalizedUrl))
            .limit(1);
          const resource = rows[0];

          if (!resource) {
            return {
              ok: false,
              error: `No resource found for URL "${normalizedUrl}".`,
            };
          }

          logger.info("get_resource tool called", {
            url: normalizedUrl,
            status: resource.status,
          });

          return {
            ok: true,
            resource: {
              id: resource.id,
              url: resource.url,
              parent_url: resource.parentUrl,
              title: resource.title,
              source: resource.source,
              status: resource.status,
              content: resource.content,
              summary: resource.summary,
              metadata: resource.metadata ?? {},
              content_hash: resource.contentHash,
              error_message: resource.errorMessage,
              crawled_at: resource.crawledAt
                ? formatTimestamp(resource.crawledAt, context?.timezone)
                : null,
              created_at: formatTimestamp(resource.createdAt, context?.timezone),
              updated_at: formatTimestamp(resource.updatedAt, context?.timezone),
            },
          };
        } catch (error: any) {
          logger.error("get_resource tool failed", {
            url,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to get resource: ${error.message}`,
          };
        }
      },
      slack: { status: "Loading resource...", detail: (i) => i.url },
    }),

    list_resources: defineTool({
      description:
        "List resources in the knowledge base. Useful for browsing what has been ingested before doing targeted retrieval. Supports optional source and status filtering. Defaults to status=ready.",
      inputSchema: z.object({
        source: z
          .enum(RESOURCE_SOURCES)
          .optional()
          .describe("Optional source filter."),
        status: z
          .enum(["pending", "ready", "error"])
          .optional()
          .default("ready")
          .describe("Optional status filter (default ready). Use to check what failed or is still processing."),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe("Max resources to return (default 20, max 50)."),
      }),
      execute: async ({ source, status, limit }) => {
        try {
          const conditions = [eq(resources.status, status)];
          if (source) conditions.push(eq(resources.source, source));

          const rows = await db
            .select({
              url: resources.url,
              title: resources.title,
              source: resources.source,
              summary: resources.summary,
              parent_url: resources.parentUrl,
              crawled_at: resources.crawledAt,
            })
            .from(resources)
            .where(and(...conditions))
            .orderBy(desc(resources.crawledAt))
            .limit(limit);

          const typedRows = rows as ResourceListRow[];
          logger.info("list_resources tool called", {
            source,
            status,
            resultCount: typedRows.length,
          });

          return {
            ok: true,
            count: typedRows.length,
            resources: typedRows.map((r) => ({
              url: r.url,
              title: r.title,
              source: r.source,
              summary: r.summary ? truncate(r.summary, 150) : null,
              parent_url: r.parent_url,
              crawled_at: r.crawled_at
                ? formatTimestamp(r.crawled_at, context?.timezone)
                : null,
            })),
          };
        } catch (error: any) {
          logger.error("list_resources tool failed", {
            source,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to list resources: ${error.message}`,
          };
        }
      },
      slack: { status: "Listing resources..." },
    }),
  };
}

import { logger } from "./logger.js";

export const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";
export const MCP_REGISTRY_CACHE_TTL_MS = 10 * 60 * 1000;
export const MCP_REGISTRY_STALE_TTL_MS = 6 * 60 * 60 * 1000;
export const MCP_REGISTRY_TIMEOUT_MS = 30_000;
export const MCP_REGISTRY_DEFAULT_LIMIT = 30;
export const MCP_REGISTRY_MAX_LIMIT = 50;

const HTTP_REMOTE_TYPES = new Set(["streamable-http", "sse"]);

export type McpCatalogTransport = "http" | "sse";

export interface McpCatalogEntry {
  name: string;
  title: string;
  description: string;
  url: string;
  transport: McpCatalogTransport;
  featured: boolean;
}

export interface CachedRegistryPage {
  fetchedAt: number;
  entries: McpCatalogEntry[];
  nextCursor: string | null;
}

export type RegistryFetch = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * Curated featured MCP servers. Each remote was probed on 2026-10-12:
 * - Stripe  https://mcp.stripe.com           GET 401 (up, auth required)
 * - Linear  https://mcp.linear.app/mcp       GET 401
 * - Notion  https://mcp.notion.com/mcp       GET 401
 * - Sentry  https://mcp.sentry.dev/mcp       GET 401 (not listed in the registry)
 * - Mako    https://app.mako.ai/api/mcp      GET 405 (host up, streamable-http)
 */
export const FEATURED_MCP_SERVERS: McpCatalogEntry[] = [
  {
    name: "com.stripe/mcp",
    title: "Stripe",
    description: "Official Stripe MCP server — customers, products, payments, and more.",
    url: "https://mcp.stripe.com",
    transport: "http",
    featured: true,
  },
  {
    name: "app.linear/linear",
    title: "Linear",
    description: "Official Linear MCP server for project management and issue tracking.",
    url: "https://mcp.linear.app/mcp",
    transport: "http",
    featured: true,
  },
  {
    name: "com.notion/mcp",
    title: "Notion",
    description: "Official Notion MCP server.",
    url: "https://mcp.notion.com/mcp",
    transport: "http",
    featured: true,
  },
  {
    name: "io.sentry/mcp",
    title: "Sentry",
    description: "Official Sentry MCP server for issues, projects, and error tracking.",
    url: "https://mcp.sentry.dev/mcp",
    transport: "http",
    featured: true,
  },
  {
    name: "io.github.mako-ai/mako",
    title: "Mako",
    description: "Explore databases, validate SQL, and build data apps in a Mako workspace.",
    url: "https://app.mako.ai/api/mcp",
    transport: "http",
    featured: true,
  },
];

export type RegistryPageCache = Map<string, CachedRegistryPage>;

const memoryCache: RegistryPageCache = new Map();

export function resetMcpRegistryCache(cache: RegistryPageCache = memoryCache): void {
  cache.clear();
}

export function registryCacheKey(search: string, cursor: string, limit: number): string {
  return `${search}\0${cursor}\0${limit}`;
}

/** Strip tags/control chars. Registry text is untrusted; never treated as HTML. */
export function untrustedPlainText(value: unknown, max = 500): string {
  if (typeof value !== "string") return "";
  return (
    value
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]*>/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max)
  );
}

export function normalizeMcpUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    if (parsed.pathname === "/") parsed.pathname = "";
    return parsed.href.replace(/\/+$/, "");
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

export function pickHttpsRemote(
  remotes: unknown,
): { url: string; transport: McpCatalogTransport } | null {
  if (!Array.isArray(remotes)) return null;
  let sse: { url: string; transport: "sse" } | null = null;
  for (const remote of remotes) {
    if (!remote || typeof remote !== "object") continue;
    const type = (remote as { type?: unknown }).type;
    const url = (remote as { url?: unknown }).url;
    if (typeof type !== "string" || typeof url !== "string") continue;
    if (!HTTP_REMOTE_TYPES.has(type)) continue;
    if (!url.toLowerCase().startsWith("https://")) continue;
    try {
      new URL(url);
    } catch {
      continue;
    }
    if (type === "streamable-http") return { url, transport: "http" };
    if (type === "sse" && !sse) sse = { url, transport: "sse" };
  }
  return sse;
}

function officialMeta(item: unknown): { isLatest?: boolean; status?: string } {
  if (!item || typeof item !== "object") return {};
  const meta = (item as { _meta?: Record<string, unknown> })._meta;
  const official = meta?.["io.modelcontextprotocol.registry/official"];
  if (!official || typeof official !== "object") return {};
  const record = official as { isLatest?: unknown; status?: unknown };
  return {
    isLatest: typeof record.isLatest === "boolean" ? record.isLatest : undefined,
    status: typeof record.status === "string" ? record.status : undefined,
  };
}

/**
 * Parse a registry `/v0.1/servers` payload into catalog entries.
 * Drops stdio-only servers, non-https remotes, non-latest versions, and
 * deleted/deprecated entries. Prefers `streamable-http` over `sse`.
 */
export function parseRegistryServers(payload: unknown): {
  entries: McpCatalogEntry[];
  nextCursor: string | null;
} {
  if (!payload || typeof payload !== "object") {
    return { entries: [], nextCursor: null };
  }
  const record = payload as {
    servers?: unknown;
    metadata?: { nextCursor?: unknown };
  };
  const nextCursor =
    typeof record.metadata?.nextCursor === "string" && record.metadata.nextCursor
      ? record.metadata.nextCursor
      : null;
  if (!Array.isArray(record.servers)) {
    return { entries: [], nextCursor };
  }

  const entries: McpCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const item of record.servers) {
    if (!item || typeof item !== "object") continue;
    const meta = officialMeta(item);
    if (meta.isLatest === false) continue;
    const status = (meta.status ?? "active").toLowerCase();
    if (status === "deleted" || status === "deprecated" || status === "archived") {
      continue;
    }
    const server = (item as { server?: unknown }).server;
    if (!server || typeof server !== "object") continue;
    const raw = server as {
      name?: unknown;
      title?: unknown;
      description?: unknown;
      remotes?: unknown;
    };
    const remote = pickHttpsRemote(raw.remotes);
    if (!remote) continue;
    const name = untrustedPlainText(raw.name, 200);
    if (!name) continue;
    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    entries.push({
      name,
      title: untrustedPlainText(raw.title, 120) || name,
      description: untrustedPlainText(raw.description, 400),
      url: remote.url,
      transport: remote.transport,
      featured: false,
    });
  }
  return { entries, nextCursor };
}

export function matchesCatalogSearch(entry: McpCatalogEntry, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [entry.title, entry.name, entry.description, entry.url].some((value) =>
    value.toLowerCase().includes(q),
  );
}

export function featuredMcpServers(search = ""): McpCatalogEntry[] {
  return FEATURED_MCP_SERVERS.filter((entry) => matchesCatalogSearch(entry, search));
}

function featuredKeys(): { names: Set<string>; urls: Set<string> } {
  return {
    names: new Set(FEATURED_MCP_SERVERS.map((entry) => entry.name.toLowerCase())),
    urls: new Set(FEATURED_MCP_SERVERS.map((entry) => normalizeMcpUrl(entry.url))),
  };
}

export function excludeFeatured(entries: McpCatalogEntry[]): McpCatalogEntry[] {
  const { names, urls } = featuredKeys();
  return entries.filter(
    (entry) => !names.has(entry.name.toLowerCase()) && !urls.has(normalizeMcpUrl(entry.url)),
  );
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return MCP_REGISTRY_DEFAULT_LIMIT;
  return Math.min(MCP_REGISTRY_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export function buildRegistryUrl(opts: {
  search?: string;
  cursor?: string;
  limit?: number;
}): string {
  const url = new URL(MCP_REGISTRY_URL);
  const limit = clampLimit(opts.limit);
  url.searchParams.set("limit", String(limit));
  const search = opts.search?.trim();
  if (search) url.searchParams.set("search", search);
  const cursor = opts.cursor?.trim();
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.href;
}

async function fetchRegistryPage(
  opts: { search?: string; cursor?: string; limit?: number },
  fetchFn: RegistryFetch,
  now: number,
): Promise<CachedRegistryPage> {
  const href = buildRegistryUrl(opts);
  const response = await fetchFn(href, {
    signal: AbortSignal.timeout(MCP_REGISTRY_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      "user-agent": "AuraMCP/0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`MCP registry returned HTTP ${response.status}`);
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("MCP registry returned invalid JSON");
  }
  const parsed = parseRegistryServers(payload);
  return {
    fetchedAt: now,
    entries: parsed.entries,
    nextCursor: parsed.nextCursor,
  };
}

export interface MarketplaceCatalog {
  featured: McpCatalogEntry[];
  items: McpCatalogEntry[];
  nextCursor: string | null;
  stale: boolean;
  error: string | null;
}

/**
 * Server-side registry proxy. Never throws: on failure returns featured
 * servers plus stale catalog items when a previous page is cached.
 */
export async function getMarketplaceCatalog(opts: {
  search?: string;
  cursor?: string;
  limit?: number;
  fetchFn?: RegistryFetch;
  now?: number;
  cache?: RegistryPageCache;
}): Promise<MarketplaceCatalog> {
  const search = opts.search?.trim() ?? "";
  const cursor = opts.cursor?.trim() ?? "";
  const limit = clampLimit(opts.limit);
  const fetchFn = opts.fetchFn ?? (fetch as RegistryFetch);
  const now = opts.now ?? Date.now();
  const cache = opts.cache ?? memoryCache;
  const key = registryCacheKey(search, cursor, limit);
  const featured = featuredMcpServers(search);
  const cached = cache.get(key);

  if (cached && now - cached.fetchedAt < MCP_REGISTRY_CACHE_TTL_MS) {
    return {
      featured,
      items: excludeFeatured(cached.entries),
      nextCursor: cached.nextCursor,
      stale: false,
      error: null,
    };
  }

  try {
    const page = await fetchRegistryPage({ search, cursor, limit }, fetchFn, now);
    cache.set(key, page);
    return {
      featured,
      items: excludeFeatured(page.entries),
      nextCursor: page.nextCursor,
      stale: false,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("MCP registry fetch failed", { error: message, search, cursor });
    const staleStillUsable = cached && now - cached.fetchedAt < MCP_REGISTRY_STALE_TTL_MS;
    if (staleStillUsable && cached) {
      return {
        featured,
        items: excludeFeatured(cached.entries),
        nextCursor: cached.nextCursor,
        stale: true,
        error: message,
      };
    }
    return {
      featured,
      items: [],
      nextCursor: null,
      stale: false,
      error: message,
    };
  }
}

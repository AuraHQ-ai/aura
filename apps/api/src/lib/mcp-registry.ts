import { logger } from "./logger.js";

export const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";
export const MCP_REGISTRY_CACHE_TTL_MS = 10 * 60 * 1000;
export const MCP_REGISTRY_STALE_TTL_MS = 6 * 60 * 60 * 1000;
export const MCP_REGISTRY_TIMEOUT_MS = 30_000;
export const MCP_REGISTRY_DEFAULT_LIMIT = 30;
export const MCP_REGISTRY_MAX_LIMIT = 50;

const HTTP_REMOTE_TYPES = new Set(["streamable-http", "sse"]);

/**
 * Registry `name` values to pin at the top of an empty marketplace browse.
 * Titles and URLs are resolved live from the registry — never hand-copied.
 * Names the registry does not return are skipped.
 */
export const PINNED_REGISTRY_NAMES = [
  "com.close/close-mcp",
  "com.stripe/mcp",
  "app.linear/linear",
  "com.notion/mcp",
  "io.github.getsentry/sentry-mcp",
  "io.github.mako-ai/mako",
] as const;

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

export type RegistryPageCache = Map<string, CachedRegistryPage>;

const memoryCache: RegistryPageCache = new Map();

export function resetMcpRegistryCache(cache: RegistryPageCache = memoryCache): void {
  cache.clear();
}

export function registryCacheKey(search: string, cursor: string, limit: number): string {
  return `${search}\0${cursor}\0${limit}`;
}

function pinnedCacheKey(names: readonly string[]): string {
  return `\0pinned\0${names.join("\0")}`;
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

function prettifyRegistrySegment(segment: string): string {
  return segment
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => {
      if (/^mcp$/i.test(word)) return "MCP";
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

/**
 * Display name when registry `title` is empty: last path segment of `name`
 * (`com.close/close-mcp` → "Close MCP"). If that segment is just "mcp"
 * (`com.stripe/mcp`), use the last label of the namespace instead ("Stripe").
 */
export function displayNameFromRegistryName(name: string): string {
  const parts = name.split("/").filter(Boolean);
  let segment = parts.at(-1) || name;
  if (/^mcp$/i.test(segment.replace(/[-_]/g, "")) && parts.length >= 2) {
    const ns = parts[parts.length - 2] ?? segment;
    segment = ns.split(".").filter(Boolean).at(-1) || ns;
  }
  return prettifyRegistrySegment(segment) || name;
}

export function searchTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function longestSearchToken(tokens: string[]): string {
  if (tokens.length === 0) return "";
  return tokens.reduce((best, token) => (token.length > best.length ? token : best));
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
    const title = untrustedPlainText(raw.title, 120) || displayNameFromRegistryName(name);
    entries.push({
      name,
      title,
      description: untrustedPlainText(raw.description, 400),
      url: remote.url,
      transport: remote.transport,
      featured: false,
    });
  }
  return { entries, nextCursor };
}

export function catalogSearchHaystack(entry: McpCatalogEntry): string {
  return [entry.name, entry.title, entry.description, displayNameFromRegistryName(entry.name)]
    .join("\n")
    .toLowerCase();
}

export function matchesCatalogSearch(entry: McpCatalogEntry, search: string): boolean {
  const tokens = searchTokens(search);
  if (tokens.length === 0) return true;
  const haystack = catalogSearchHaystack(entry);
  return tokens.every((token) => haystack.includes(token));
}

export function excludePinned(
  entries: McpCatalogEntry[],
  pinned: McpCatalogEntry[],
): McpCatalogEntry[] {
  const names = new Set(pinned.map((entry) => entry.name.toLowerCase()));
  const urls = new Set(pinned.map((entry) => normalizeMcpUrl(entry.url)));
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

export function buildPinnedServerUrl(name: string): string {
  return `${MCP_REGISTRY_URL}/${encodeURIComponent(name)}/versions/latest`;
}

function registryRequestHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "user-agent": "AuraMCP/0.1",
  };
}

async function parseJsonBody(response: { text(): Promise<string> }): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("MCP registry returned invalid JSON");
  }
}

async function fetchRegistryPage(
  opts: { search?: string; cursor?: string; limit?: number },
  fetchFn: RegistryFetch,
  now: number,
): Promise<CachedRegistryPage> {
  const href = buildRegistryUrl(opts);
  const response = await fetchFn(href, {
    signal: AbortSignal.timeout(MCP_REGISTRY_TIMEOUT_MS),
    headers: registryRequestHeaders(),
  });
  if (!response.ok) {
    throw new Error(`MCP registry returned HTTP ${response.status}`);
  }
  const parsed = parseRegistryServers(await parseJsonBody(response));
  return {
    fetchedAt: now,
    entries: parsed.entries,
    nextCursor: parsed.nextCursor,
  };
}

interface CatalogPageResult {
  entries: McpCatalogEntry[];
  nextCursor: string | null;
  stale: boolean;
  error: string | null;
}

async function loadCatalogPage(opts: {
  search: string;
  cursor: string;
  limit: number;
  fetchFn: RegistryFetch;
  now: number;
  cache: RegistryPageCache;
}): Promise<CatalogPageResult> {
  const key = registryCacheKey(opts.search, opts.cursor, opts.limit);
  const cached = opts.cache.get(key);

  if (cached && opts.now - cached.fetchedAt < MCP_REGISTRY_CACHE_TTL_MS) {
    return {
      entries: cached.entries,
      nextCursor: cached.nextCursor,
      stale: false,
      error: null,
    };
  }

  try {
    const page = await fetchRegistryPage(
      { search: opts.search || undefined, cursor: opts.cursor || undefined, limit: opts.limit },
      opts.fetchFn,
      opts.now,
    );
    opts.cache.set(key, page);
    return {
      entries: page.entries,
      nextCursor: page.nextCursor,
      stale: false,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("MCP registry fetch failed", {
      error: message,
      search: opts.search,
      cursor: opts.cursor,
    });
    const staleStillUsable = cached && opts.now - cached.fetchedAt < MCP_REGISTRY_STALE_TTL_MS;
    if (staleStillUsable && cached) {
      return {
        entries: cached.entries,
        nextCursor: cached.nextCursor,
        stale: true,
        error: message,
      };
    }
    return {
      entries: [],
      nextCursor: null,
      stale: false,
      error: message,
    };
  }
}

async function fetchPinnedServer(
  name: string,
  fetchFn: RegistryFetch,
): Promise<McpCatalogEntry | null> {
  try {
    const response = await fetchFn(buildPinnedServerUrl(name), {
      signal: AbortSignal.timeout(MCP_REGISTRY_TIMEOUT_MS),
      headers: registryRequestHeaders(),
    });
    if (!response.ok) return null;
    const parsed = parseRegistryServers({ servers: [await parseJsonBody(response)] });
    const entry = parsed.entries.find((item) => item.name.toLowerCase() === name.toLowerCase());
    return entry ? { ...entry, featured: true } : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("MCP registry pinned lookup failed", { name, error: message });
    return null;
  }
}

async function resolvePinnedServers(opts: {
  names: readonly string[];
  fetchFn: RegistryFetch;
  now: number;
  cache: RegistryPageCache;
}): Promise<{ entries: McpCatalogEntry[]; stale: boolean }> {
  if (opts.names.length === 0) return { entries: [], stale: false };

  const key = pinnedCacheKey(opts.names);
  const cached = opts.cache.get(key);
  if (cached && opts.now - cached.fetchedAt < MCP_REGISTRY_CACHE_TTL_MS) {
    return { entries: cached.entries, stale: false };
  }

  const fetched = await Promise.all(
    opts.names.map((name) => fetchPinnedServer(name, opts.fetchFn)),
  );
  const entries = fetched.filter((entry): entry is McpCatalogEntry => entry !== null);

  if (entries.length > 0) {
    opts.cache.set(key, { fetchedAt: opts.now, entries, nextCursor: null });
    return { entries, stale: false };
  }

  if (cached && opts.now - cached.fetchedAt < MCP_REGISTRY_STALE_TTL_MS) {
    return { entries: cached.entries, stale: true };
  }
  return { entries: [], stale: false };
}

export interface MarketplaceCatalog {
  featured: McpCatalogEntry[];
  items: McpCatalogEntry[];
  nextCursor: string | null;
  stale: boolean;
  error: string | null;
}

/**
 * Server-side registry proxy. Never throws: on failure returns any live-resolved
 * pinned servers plus stale catalog items when a previous page is cached.
 *
 * Search: split the query into tokens, ask the registry for the longest token
 * (it only substring-matches one string, on names), then keep entries where
 * every token matches name, title, description, or the derived display name.
 * If that yields nothing, retry with the first token and filter again.
 */
export async function getMarketplaceCatalog(opts: {
  search?: string;
  cursor?: string;
  limit?: number;
  fetchFn?: RegistryFetch;
  now?: number;
  cache?: RegistryPageCache;
  pinnedNames?: readonly string[];
}): Promise<MarketplaceCatalog> {
  const search = opts.search?.trim() ?? "";
  const cursor = opts.cursor?.trim() ?? "";
  const limit = clampLimit(opts.limit);
  const fetchFn = opts.fetchFn ?? (fetch as RegistryFetch);
  const now = opts.now ?? Date.now();
  const cache = opts.cache ?? memoryCache;
  const pinnedNames = opts.pinnedNames ?? PINNED_REGISTRY_NAMES;
  const tokens = searchTokens(search);
  const primaryToken = longestSearchToken(tokens);

  const loadPage = (registrySearch: string) =>
    loadCatalogPage({ search: registrySearch, cursor, limit, fetchFn, now, cache });

  const [page, pinnedResult] = await Promise.all([
    loadPage(primaryToken),
    resolvePinnedServers({ names: pinnedNames, fetchFn, now, cache }),
  ]);

  let resolved = page;
  let items = page.entries.filter((entry) => matchesCatalogSearch(entry, search));
  const fallbackToken = tokens[0] ?? "";
  if (items.length === 0 && !cursor && fallbackToken && fallbackToken !== primaryToken) {
    const retry = await loadPage(fallbackToken);
    const retryItems = retry.entries.filter((entry) => matchesCatalogSearch(entry, search));
    if (retryItems.length > 0 || page.entries.length === 0) {
      resolved = retry;
      items = retryItems;
    }
  }

  const featured = pinnedResult.entries
    .filter((entry) => matchesCatalogSearch(entry, search))
    .map((entry) => ({ ...entry, featured: true }));

  return {
    featured,
    items: excludePinned(items, pinnedResult.entries),
    nextCursor: resolved.nextCursor,
    stale: resolved.stale || pinnedResult.stale,
    error: resolved.error,
  };
}

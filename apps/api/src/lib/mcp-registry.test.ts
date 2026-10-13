import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  MCP_REGISTRY_CACHE_TTL_MS,
  PINNED_REGISTRY_NAMES,
  buildPinnedServerUrl,
  buildRegistryUrl,
  displayNameFromRegistryName,
  excludePinned,
  getMarketplaceCatalog,
  longestSearchToken,
  matchesCatalogSearch,
  parseRegistryServers,
  pickHttpsRemote,
  resetMcpRegistryCache,
  searchTokens,
  untrustedPlainText,
  type McpCatalogEntry,
  type RegistryFetch,
  type RegistryPageCache,
} from "./mcp-registry.js";

function registryItem(overrides: {
  name?: string;
  title?: unknown;
  description?: unknown;
  remotes?: unknown;
  isLatest?: boolean;
  status?: string;
}) {
  return {
    server: {
      name: overrides.name ?? "com.example/mcp",
      title: overrides.title ?? "Example",
      description: overrides.description ?? "An example server",
      remotes: overrides.remotes ?? [
        { type: "streamable-http", url: "https://mcp.example.com/mcp" },
      ],
    },
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        isLatest: overrides.isLatest ?? true,
        status: overrides.status ?? "active",
      },
    },
  };
}

function closeCrmItem() {
  return registryItem({
    name: "com.close/close-mcp",
    title: "",
    description: "Close CRM to manage your sales pipeline. Learn more at https://close.com",
    remotes: [{ type: "streamable-http", url: "https://mcp.close.com/mcp" }],
  });
}

function catalogEntry(overrides: Partial<McpCatalogEntry> = {}): McpCatalogEntry {
  return {
    name: "com.example/mcp",
    title: "Example",
    description: "An example server",
    url: "https://mcp.example.com/mcp",
    transport: "http",
    featured: false,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

afterEach(() => {
  resetMcpRegistryCache();
});

describe("untrustedPlainText", () => {
  it("strips HTML tags and control characters", () => {
    expect(untrustedPlainText('<img src=x onerror="alert(1)">Hello\u0007 <b>world</b>')).toBe(
      "Hello world",
    );
  });

  it("returns empty string for non-strings", () => {
    expect(untrustedPlainText({ html: "<b>x</b>" })).toBe("");
    expect(untrustedPlainText(null)).toBe("");
  });
});

describe("displayNameFromRegistryName", () => {
  it("uses the last path segment, prettified", () => {
    expect(displayNameFromRegistryName("com.close/close-mcp")).toBe("Close MCP");
    expect(displayNameFromRegistryName("io.github.getsentry/sentry-mcp")).toBe("Sentry MCP");
  });

  it("falls back to the namespace label when the last segment is just mcp", () => {
    expect(displayNameFromRegistryName("com.stripe/mcp")).toBe("Stripe");
    expect(displayNameFromRegistryName("com.notion/mcp")).toBe("Notion");
  });
});

describe("searchTokens", () => {
  it("splits on whitespace and picks the longest token", () => {
    expect(searchTokens("  Close   CRM ")).toEqual(["close", "crm"]);
    expect(longestSearchToken(["close", "crm"])).toBe("close");
    expect(longestSearchToken(["acme", "extraordinary"])).toBe("extraordinary");
  });
});

describe("pickHttpsRemote", () => {
  it("prefers streamable-http over sse and skips stdio", () => {
    expect(
      pickHttpsRemote([
        { type: "stdio", url: "https://ignored.example/stdio" },
        { type: "sse", url: "https://mcp.example.com/sse" },
        { type: "streamable-http", url: "https://mcp.example.com/mcp" },
      ]),
    ).toEqual({ url: "https://mcp.example.com/mcp", transport: "http" });
  });

  it("falls back to sse when no streamable-http remote exists", () => {
    expect(pickHttpsRemote([{ type: "sse", url: "https://mcp.example.com/sse" }])).toEqual({
      url: "https://mcp.example.com/sse",
      transport: "sse",
    });
  });

  it("skips non-https remotes", () => {
    expect(
      pickHttpsRemote([
        { type: "streamable-http", url: "http://mcp.example.com/mcp" },
        { type: "sse", url: "stdio://local" },
      ]),
    ).toBeNull();
  });

  it("returns null for stdio-only servers", () => {
    expect(pickHttpsRemote([{ type: "stdio" }])).toBeNull();
    expect(pickHttpsRemote([])).toBeNull();
    expect(pickHttpsRemote(undefined)).toBeNull();
  });
});

describe("parseRegistryServers", () => {
  it("keeps https streamable-http/sse remotes and drops stdio-only", () => {
    const parsed = parseRegistryServers({
      servers: [
        registryItem({ name: "com.ok/http" }),
        registryItem({
          name: "com.ok/sse",
          remotes: [{ type: "sse", url: "https://sse.example.com/mcp" }],
        }),
        registryItem({
          name: "com.skip/stdio",
          remotes: [{ type: "stdio" }],
        }),
        registryItem({
          name: "com.skip/http-remote",
          remotes: [{ type: "streamable-http", url: "http://insecure.example/mcp" }],
        }),
      ],
      metadata: { nextCursor: "next-1", count: 4 },
    });
    expect(parsed.nextCursor).toBe("next-1");
    expect(parsed.entries.map((e) => e.name)).toEqual(["com.ok/http", "com.ok/sse"]);
    expect(parsed.entries[1]?.transport).toBe("sse");
  });

  it("skips non-latest versions, deprecated entries, and sanitizes text", () => {
    const parsed = parseRegistryServers({
      servers: [
        registryItem({
          name: "com.ok/mcp",
          title: "<script>alert(1)</script>Safe",
          description: "Hello <b>there</b>",
        }),
        registryItem({ name: "com.old/mcp", isLatest: false }),
        registryItem({ name: "com.dead/mcp", status: "deprecated" }),
        registryItem({ name: "com.gone/mcp", status: "deleted" }),
      ],
    });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.title).toBe("Safe");
    expect(parsed.entries[0]?.description).toBe("Hello there");
    expect(parsed.entries[0]?.featured).toBe(false);
  });

  it("derives a display title when registry title is empty", () => {
    const parsed = parseRegistryServers({
      servers: [closeCrmItem()],
    });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.name).toBe("com.close/close-mcp");
    expect(parsed.entries[0]?.title).toBe("Close MCP");
    expect(parsed.entries[0]?.url).toBe("https://mcp.close.com/mcp");
  });

  it("handles a missing or malformed payload without throwing", () => {
    expect(parseRegistryServers(null)).toEqual({ entries: [], nextCursor: null });
    expect(parseRegistryServers({ servers: "nope" })).toEqual({
      entries: [],
      nextCursor: null,
    });
  });
});

describe("matchesCatalogSearch", () => {
  it("requires every token to match name, title, description, or derived display name", () => {
    const close = catalogEntry({
      name: "com.close/close-mcp",
      title: "Close MCP",
      description: "Close CRM to manage your sales pipeline.",
      url: "https://mcp.close.com/mcp",
    });
    expect(matchesCatalogSearch(close, "close crm")).toBe(true);
    expect(matchesCatalogSearch(close, "close")).toBe(true);
    expect(matchesCatalogSearch(close, "stripe")).toBe(false);

    const emptyTitle = catalogEntry({
      name: "com.close/close-mcp",
      title: "",
      description: "Close CRM to manage your sales pipeline.",
    });
    expect(matchesCatalogSearch(emptyTitle, "close mcp")).toBe(true);
  });
});

describe("PINNED_REGISTRY_NAMES", () => {
  it("is names only — no hand-copied titles or URLs", () => {
    expect(PINNED_REGISTRY_NAMES).toContain("com.close/close-mcp");
    expect(PINNED_REGISTRY_NAMES).toContain("com.stripe/mcp");
    expect(PINNED_REGISTRY_NAMES.every((name) => name.includes("/"))).toBe(true);
  });
});

describe("getMarketplaceCatalog cache + failure fallback", () => {
  it("caches a successful registry page and serves it while fresh", async () => {
    const fetchFn = vi.fn<RegistryFetch>(async () =>
      jsonResponse({
        servers: [registryItem({ name: "com.ok/mcp", title: "Ok" })],
        metadata: { nextCursor: "c2" },
      }),
    );

    const cache: RegistryPageCache = new Map();
    const first = await getMarketplaceCatalog({
      fetchFn,
      cache,
      now: 1_000,
      pinnedNames: [],
    });
    expect(first.items[0]?.name).toBe("com.ok/mcp");
    expect(first.nextCursor).toBe("c2");
    expect(first.stale).toBe(false);
    expect(first.error).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const second = await getMarketplaceCatalog({
      fetchFn,
      cache,
      now: 1_000 + MCP_REGISTRY_CACHE_TTL_MS - 1,
      pinnedNames: [],
    });
    expect(second.items[0]?.name).toBe("com.ok/mcp");
    expect(second.stale).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns stale cache and an error when the registry fails", async () => {
    const fetchFn = vi
      .fn<RegistryFetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          servers: [registryItem({ name: "com.ok/mcp", title: "Ok" })],
          metadata: {},
        }),
      )
      .mockRejectedValueOnce(new Error("registry down"));

    const cache: RegistryPageCache = new Map();
    await getMarketplaceCatalog({ fetchFn, cache, now: 1_000, pinnedNames: [] });
    const stale = await getMarketplaceCatalog({
      fetchFn,
      cache,
      now: 1_000 + MCP_REGISTRY_CACHE_TTL_MS + 1,
      pinnedNames: [],
    });
    expect(stale.items[0]?.name).toBe("com.ok/mcp");
    expect(stale.stale).toBe(true);
    expect(stale.error).toMatch(/registry down/);
    expect(stale.featured).toEqual([]);
  });

  it("returns empty featured plus error when there is no cache to fall back to", async () => {
    const fetchFn = vi.fn<RegistryFetch>(async () => {
      throw new Error("timeout");
    });
    const result = await getMarketplaceCatalog({
      fetchFn,
      cache: new Map(),
      search: "stripe",
      pinnedNames: [],
    });
    expect(result.items).toEqual([]);
    expect(result.featured).toEqual([]);
    expect(result.stale).toBe(false);
    expect(result.error).toMatch(/timeout/);
  });

  it("does not duplicate pinned vendors in the registry list", () => {
    const items = excludePinned(
      [
        catalogEntry({
          name: "com.stripe/mcp",
          title: "Stripe",
          url: "https://mcp.stripe.com",
        }),
        catalogEntry({
          name: "com.other/mcp",
          title: "Other",
          url: "https://other.example/mcp",
        }),
      ],
      [catalogEntry({ name: "com.stripe/mcp", title: "Stripe", url: "https://mcp.stripe.com" })],
    );
    expect(items.map((i) => i.name)).toEqual(["com.other/mcp"]);
  });

  it("builds the official registry URL with search, limit, and cursor", () => {
    const href = buildRegistryUrl({ search: "stripe", cursor: "abc", limit: 10 });
    expect(href).toContain("registry.modelcontextprotocol.io/v0.1/servers");
    expect(href).toContain("search=stripe");
    expect(href).toContain("limit=10");
    expect(href).toContain("cursor=abc");
  });
});

describe("getMarketplaceCatalog multi-token search", () => {
  it("queries the longest token and keeps com.close/close-mcp for 'close crm'", async () => {
    const fetchFn = vi.fn<RegistryFetch>(async (url) => {
      const href = String(url);
      if (href.includes("search=close")) {
        return jsonResponse({
          servers: [
            closeCrmItem(),
            registryItem({
              name: "city.close/close-api",
              title: "Close API",
              description: "Walk and transit travel times.",
            }),
          ],
          metadata: {},
        });
      }
      if (href.includes("search=close+crm") || href.includes("search=close%20crm")) {
        return jsonResponse({ servers: [], metadata: {} });
      }
      return jsonResponse({ servers: [], metadata: {} });
    });

    const result = await getMarketplaceCatalog({
      fetchFn,
      cache: new Map(),
      search: "close crm",
      pinnedNames: [],
    });

    expect(result.error).toBeNull();
    expect(result.items.map((e) => e.name)).toEqual(["com.close/close-mcp"]);
    expect(result.items[0]?.title).toBe("Close MCP");
    const searched = fetchFn.mock.calls.map(([url]) => String(url));
    expect(searched.some((url) => url.includes("search=close"))).toBe(true);
    expect(searched.some((url) => url.includes("crm"))).toBe(false);
  });

  it("retries with the first token when the longest token returns nothing", async () => {
    const fetchFn = vi.fn<RegistryFetch>(async (url) => {
      const href = String(url);
      if (href.includes("search=extraordinary")) {
        return jsonResponse({ servers: [], metadata: {} });
      }
      if (href.includes("search=acme")) {
        return jsonResponse({
          servers: [
            registryItem({
              name: "com.acme/mcp",
              title: "Acme",
              description: "The extraordinary Acme MCP",
            }),
          ],
          metadata: {},
        });
      }
      return jsonResponse({ servers: [], metadata: {} });
    });

    const result = await getMarketplaceCatalog({
      fetchFn,
      cache: new Map(),
      search: "acme extraordinary",
      pinnedNames: [],
    });

    expect(result.items.map((e) => e.name)).toEqual(["com.acme/mcp"]);
    const searched = fetchFn.mock.calls.map(([url]) => String(url));
    expect(searched.some((url) => url.includes("search=extraordinary"))).toBe(true);
    expect(searched.some((url) => url.includes("search=acme"))).toBe(true);
  });
});

describe("getMarketplaceCatalog live pinned names", () => {
  it("resolves title and URL from the registry and skips missing names", async () => {
    const fetchFn = vi.fn<RegistryFetch>(async (url) => {
      const href = String(url);
      if (href === buildPinnedServerUrl("com.close/close-mcp")) {
        return jsonResponse(closeCrmItem());
      }
      if (href === buildPinnedServerUrl("io.sentry/mcp")) {
        return { ok: false, status: 404, text: async () => "not found" };
      }
      if (href.includes("/v0.1/servers?") && !href.includes("/versions/")) {
        return jsonResponse({
          servers: [registryItem({ name: "com.other/mcp", title: "Other" })],
          metadata: {},
        });
      }
      return { ok: false, status: 404, text: async () => "not found" };
    });

    const result = await getMarketplaceCatalog({
      fetchFn,
      cache: new Map(),
      pinnedNames: ["com.close/close-mcp", "io.sentry/mcp"],
    });

    expect(result.featured.map((e) => e.name)).toEqual(["com.close/close-mcp"]);
    expect(result.featured[0]?.title).toBe("Close MCP");
    expect(result.featured[0]?.url).toBe("https://mcp.close.com/mcp");
    expect(result.featured[0]?.featured).toBe(true);
    expect(result.items.map((e) => e.name)).toEqual(["com.other/mcp"]);
  });

  it("still shows live-resolved pinned servers when the list fetch fails", async () => {
    const fetchFn = vi.fn<RegistryFetch>(async (url) => {
      const href = String(url);
      if (href === buildPinnedServerUrl("com.close/close-mcp")) {
        return jsonResponse(closeCrmItem());
      }
      throw new Error("list down");
    });

    const result = await getMarketplaceCatalog({
      fetchFn,
      cache: new Map(),
      pinnedNames: ["com.close/close-mcp"],
    });

    expect(result.featured[0]?.name).toBe("com.close/close-mcp");
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/list down/);
  });
});

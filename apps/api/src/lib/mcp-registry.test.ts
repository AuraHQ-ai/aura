import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  FEATURED_MCP_SERVERS,
  MCP_REGISTRY_CACHE_TTL_MS,
  buildRegistryUrl,
  excludeFeatured,
  featuredMcpServers,
  getMarketplaceCatalog,
  parseRegistryServers,
  pickHttpsRemote,
  resetMcpRegistryCache,
  untrustedPlainText,
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

  it("handles a missing or malformed payload without throwing", () => {
    expect(parseRegistryServers(null)).toEqual({ entries: [], nextCursor: null });
    expect(parseRegistryServers({ servers: "nope" })).toEqual({
      entries: [],
      nextCursor: null,
    });
  });
});

describe("featuredMcpServers", () => {
  it("includes the five curated vendors", () => {
    expect(FEATURED_MCP_SERVERS.map((s) => s.title)).toEqual([
      "Stripe",
      "Linear",
      "Notion",
      "Sentry",
      "Mako",
    ]);
    expect(FEATURED_MCP_SERVERS.every((s) => s.url.startsWith("https://"))).toBe(true);
  });

  it("filters featured entries by search", () => {
    expect(featuredMcpServers("stripe").map((s) => s.title)).toEqual(["Stripe"]);
    expect(featuredMcpServers("no-such-vendor")).toEqual([]);
  });
});

describe("getMarketplaceCatalog cache + failure fallback", () => {
  it("caches a successful registry page and serves it while fresh", async () => {
    const fetchFn = vi.fn<RegistryFetch>(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          servers: [registryItem({ name: "com.ok/mcp", title: "Ok" })],
          metadata: { nextCursor: "c2" },
        }),
    }));

    const cache: RegistryPageCache = new Map();
    const first = await getMarketplaceCatalog({ fetchFn, cache, now: 1_000 });
    expect(first.items[0]?.name).toBe("com.ok/mcp");
    expect(first.nextCursor).toBe("c2");
    expect(first.stale).toBe(false);
    expect(first.error).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const second = await getMarketplaceCatalog({
      fetchFn,
      cache,
      now: 1_000 + MCP_REGISTRY_CACHE_TTL_MS - 1,
    });
    expect(second.items[0]?.name).toBe("com.ok/mcp");
    expect(second.stale).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns stale cache and an error when the registry fails", async () => {
    const fetchFn = vi
      .fn<RegistryFetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            servers: [registryItem({ name: "com.ok/mcp", title: "Ok" })],
            metadata: {},
          }),
      })
      .mockRejectedValueOnce(new Error("registry down"));

    const cache: RegistryPageCache = new Map();
    await getMarketplaceCatalog({ fetchFn, cache, now: 1_000 });
    const stale = await getMarketplaceCatalog({
      fetchFn,
      cache,
      now: 1_000 + MCP_REGISTRY_CACHE_TTL_MS + 1,
    });
    expect(stale.items[0]?.name).toBe("com.ok/mcp");
    expect(stale.stale).toBe(true);
    expect(stale.error).toMatch(/registry down/);
    expect(stale.featured.map((s) => s.title)).toContain("Stripe");
  });

  it("returns featured-only plus error when there is no cache to fall back to", async () => {
    const fetchFn = vi.fn<RegistryFetch>(async () => {
      throw new Error("timeout");
    });
    const result = await getMarketplaceCatalog({
      fetchFn,
      cache: new Map(),
      search: "stripe",
    });
    expect(result.items).toEqual([]);
    expect(result.stale).toBe(false);
    expect(result.error).toMatch(/timeout/);
    expect(result.featured.map((s) => s.title)).toEqual(["Stripe"]);
  });

  it("does not duplicate featured vendors in the registry list", () => {
    const items = excludeFeatured([
      {
        name: "com.stripe/mcp",
        title: "Stripe",
        description: "dup",
        url: "https://mcp.stripe.com",
        transport: "http",
        featured: false,
      },
      {
        name: "com.other/mcp",
        title: "Other",
        description: "ok",
        url: "https://other.example/mcp",
        transport: "http",
        featured: false,
      },
    ]);
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

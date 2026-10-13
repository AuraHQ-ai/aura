import { beforeEach, describe, expect, it, vi } from "vitest";
import { executionContext } from "../lib/tool.js";

const getCatalogMock = vi.hoisted(() => vi.fn());
const dbState = vi.hoisted(() => ({
  servers: [] as Array<{ id: string; url: string; slug: string; enabled: boolean }>,
}));

vi.mock("../lib/tool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tool.js")>();
  return {
    ...actual,
    defineTool: (config: unknown) => config,
  };
});

vi.mock("../db/client.js", () => {
  const chain = () => {
    const q: Record<string, unknown> = {};
    const ret = () => q;
    q.from = ret;
    q.where = () => Promise.resolve(dbState.servers);
    q.orderBy = ret;
    q.limit = ret;
    q.values = ret;
    q.returning = async () => [];
    q.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(dbState.servers).then(resolve, reject);
    return q;
  };
  return {
    db: {
      select: vi.fn(() => chain()),
      insert: vi.fn(() => chain()),
      update: vi.fn(() => chain()),
      delete: vi.fn(() => chain()),
    },
  };
});

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../lib/mcp-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mcp-registry.js")>();
  return {
    ...actual,
    getMarketplaceCatalog: (...args: unknown[]) => getCatalogMock(...args),
  };
});

import { createMcpTools } from "./mcp.js";

function catalogEntry(overrides: Record<string, unknown> = {}) {
  return {
    name: "com.close/close-mcp",
    title: "Close MCP",
    description: "Close CRM to manage your sales pipeline.",
    url: "https://mcp.close.com/mcp",
    transport: "http" as const,
    featured: false,
    ...overrides,
  };
}

beforeEach(() => {
  dbState.servers = [];
  getCatalogMock.mockReset();
  getCatalogMock.mockResolvedValue({
    featured: [],
    items: [catalogEntry()],
    nextCursor: null,
    stale: false,
    error: null,
  });
});

describe("mcp_search_registry", () => {
  it("is registered next to the other MCP management tools", async () => {
    const tools = await createMcpTools({ userId: "U1", workspaceId: "default" });
    expect(tools.mcp_search_registry).toBeDefined();
    expect(tools.mcp_add_server).toBeDefined();
    expect(tools.mcp_list_servers).toBeDefined();
  });

  it("returns name, display title, description, URL, and installed state", async () => {
    dbState.servers = [
      { id: "srv-1", url: "https://mcp.close.com/mcp", slug: "close_mcp", enabled: true },
    ];
    getCatalogMock.mockResolvedValue({
      featured: [catalogEntry({ featured: true })],
      items: [
        catalogEntry({
          name: "city.close/close-api",
          title: "Close API",
          description: "Travel times.",
          url: "https://mcp.close.city/mcp",
        }),
      ],
      nextCursor: "next",
      stale: false,
      error: null,
    });

    const tools = await createMcpTools({ userId: "U1", workspaceId: "default" });
    const result = await tools.mcp_search_registry.execute({ query: "close crm" });

    expect(getCatalogMock).toHaveBeenCalledWith({ search: "close crm" });
    expect(result.ok).toBe(true);
    expect(result.results).toEqual([
      {
        name: "com.close/close-mcp",
        title: "Close MCP",
        description: "Close CRM to manage your sales pipeline.",
        url: "https://mcp.close.com/mcp",
        transport: "http",
        installed: true,
      },
      {
        name: "city.close/close-api",
        title: "Close API",
        description: "Travel times.",
        url: "https://mcp.close.city/mcp",
        transport: "http",
        installed: false,
      },
    ]);
    expect(result.next_cursor).toBe("next");
  });

  it("is omitted from scheduled-job turns even when an MCP server is allowlisted", async () => {
    const tools = await executionContext.run(
      {
        triggeredBy: "job",
        triggerType: "scheduled_job",
        envAllowlist: ["mcp:close_mcp"],
        workspaceId: "default",
      },
      () => createMcpTools({ userId: "U1", workspaceId: "default" }),
    );
    expect(tools.mcp_search_registry).toBeUndefined();
    expect(tools.mcp_add_server).toBeUndefined();
  });
});

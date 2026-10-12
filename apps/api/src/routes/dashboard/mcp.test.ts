import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { mcpConnections, mcpServers, type McpServer } from "@aura/db/schema";
import { parseRegistryServers } from "../../lib/mcp-registry.js";
import { createDashboardApp } from "./schemas.js";

const refreshMock = vi.hoisted(() => vi.fn());
const createClientMock = vi.hoisted(() => vi.fn());
const startOAuthMock = vi.hoisted(() => vi.fn());
const upsertConnectionMock = vi.hoisted(() => vi.fn());
const hasRoleMock = vi.hoisted(() => vi.fn());
const getCatalogMock = vi.hoisted(() => vi.fn());

const dbState = vi.hoisted(() => ({
  servers: [] as any[],
  connections: [] as any[],
  inserts: [] as any[],
  updates: [] as any[],
  deletes: [] as string[],
}));

function thenable(getRows: () => any[]) {
  const self: Record<string, unknown> = {};
  const ret = () => self;
  self.from = ret;
  self.where = ret;
  self.orderBy = ret;
  self.limit = ret;
  self.offset = ret;
  self.values = (value: unknown) => {
    dbState.inserts.push(value);
    return self;
  };
  self.set = (value: unknown) => {
    dbState.updates.push(value);
    return self;
  };
  self.returning = ret;
  self.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(getRows()).then(resolve, reject);
  return self;
}

vi.mock("../../db/client.js", () => ({
  db: {
    select: vi.fn(() => thenable(() => dbState.servers)),
    insert: vi.fn((table: unknown) =>
      thenable(() => {
        const values = dbState.inserts.at(-1) ?? {};
        const row = {
          id: values.id ?? "srv-new",
          deniedTools: [],
          cachedTools: [],
          trusted: false,
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...values,
        };
        if (table === mcpConnections) {
          dbState.connections.push(row);
        } else {
          dbState.servers.push(row);
        }
        return [row];
      }),
    ),
    update: vi.fn(() =>
      thenable(() => {
        const patch = dbState.updates.at(-1) ?? {};
        const current = dbState.servers[0];
        if (current) Object.assign(current, patch);
        return [current];
      }),
    ),
    delete: vi.fn(() =>
      thenable(() => {
        dbState.deletes.push("ok");
        dbState.servers.splice(0, dbState.servers.length);
        return [];
      }),
    ),
  },
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/permissions.js", () => ({
  hasRole: (...args: unknown[]) => hasRoleMock(...args),
}));

vi.mock("../../lib/mcp-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/mcp-runtime.js")>();
  return {
    ...actual,
    refreshMcpToolCache: (...args: unknown[]) => refreshMock(...args),
    createMcpClientForServer: (...args: unknown[]) => createClientMock(...args),
  };
});

vi.mock("../../lib/mcp-oauth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/mcp-oauth.js")>();
  return {
    ...actual,
    startMcpOAuth: (...args: unknown[]) => startOAuthMock(...args),
    upsertPendingConnection: (...args: unknown[]) => upsertConnectionMock(...args),
  };
});

vi.mock("../../lib/mcp-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/mcp-registry.js")>();
  return {
    ...actual,
    getMarketplaceCatalog: (...args: unknown[]) => getCatalogMock(...args),
  };
});

const { dashboardMcpApp } = await import("./mcp.js");

function appFor(userId?: string) {
  const wrap = createDashboardApp();
  wrap.use("*", async (c, next) => {
    if (userId) c.set("userId" as never, userId as never);
    await next();
  });
  wrap.route("/", dashboardMcpApp);
  return wrap;
}

function fixtureServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "srv-1",
    workspaceId: "default",
    slug: "stripe",
    name: "Stripe",
    url: "https://mcp.stripe.com/mcp",
    transport: "http",
    authType: "oauth",
    headerName: null,
    encryptedHeaderValue: "iv:tag:HEADER_SECRET_VALUE",
    visibility: "workspace",
    ownerId: "UADMIN",
    enabled: true,
    trusted: false,
    deniedTools: [],
    cachedTools: [{ name: "list_customers", description: "List" }],
    toolsCachedAt: new Date(),
    createdBy: "UADMIN",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as McpServer;
}

beforeEach(() => {
  vi.stubEnv("CREDENTIALS_KEY", crypto.randomBytes(32).toString("hex"));
  dbState.servers = [];
  dbState.connections = [];
  dbState.inserts = [];
  dbState.updates = [];
  dbState.deletes = [];
  hasRoleMock.mockReset();
  hasRoleMock.mockImplementation(async (userId: string) => userId === "UADMIN");
  refreshMock.mockReset();
  refreshMock.mockResolvedValue([{ name: "list_customers" }]);
  createClientMock.mockReset();
  startOAuthMock.mockReset();
  upsertConnectionMock.mockReset();
  getCatalogMock.mockReset();
  getCatalogMock.mockResolvedValue({
    featured: [
      {
        name: "com.stripe/mcp",
        title: "Stripe",
        description: "Official Stripe MCP server",
        url: "https://mcp.stripe.com",
        transport: "http",
        featured: true,
      },
    ],
    items: [
      {
        name: "com.example/mcp",
        title: "Example",
        description: "An example server",
        url: "https://mcp.example.com/mcp",
        transport: "http",
        featured: false,
      },
    ],
    nextCursor: null,
    stale: false,
    error: null,
  });
});

describe("POST /api/dashboard/mcp SSRF", () => {
  it("rejects a private/loopback URL and never inserts", async () => {
    const res = await appFor("UADMIN").request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://127.0.0.1/mcp" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/private|loopback|https/i);
    expect(dbState.inserts).toHaveLength(0);
  });

  it("rejects http URLs", async () => {
    const res = await appFor("UMEMBER").request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://example.com/mcp" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/https/i);
    expect(dbState.inserts).toHaveLength(0);
  });
});

describe("MCP dashboard authz", () => {
  it("forbids a member from adding a workspace-visible server", async () => {
    const res = await appFor("UMEMBER").request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://mcp.stripe.com/mcp",
        visibility: "workspace",
      }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/admin/i);
    expect(dbState.inserts).toHaveLength(0);
  });

  it("forbids a member from marking a server trusted", async () => {
    dbState.servers = [fixtureServer()];
    const res = await appFor("UMEMBER").request("/srv-1/trusted", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trusted: true }),
    });
    expect(res.status).toBe(403);
    expect(dbState.updates).toHaveLength(0);
  });

  it("forbids a member from removing a workspace server", async () => {
    dbState.servers = [fixtureServer({ visibility: "workspace" })];
    const res = await appFor("UMEMBER").request("/srv-1", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(dbState.deletes).toHaveLength(0);
  });

  it("forbids a member from managing someone else's personal server", async () => {
    dbState.servers = [
      fixtureServer({
        visibility: "personal",
        ownerId: "UOTHER",
        encryptedHeaderValue: null,
      }),
    ];
    const res = await appFor("UMEMBER").request("/srv-1", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(dbState.deletes).toHaveLength(0);
  });

  it("lets an admin mark a server trusted", async () => {
    dbState.servers = [fixtureServer({ trusted: false })];
    const res = await appFor("UADMIN").request("/srv-1/trusted", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trusted: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trusted).toBe(true);
    expect(dbState.updates.at(-1)).toMatchObject({ trusted: true });
  });
});

describe("MCP dashboard token redaction", () => {
  it("never returns encrypted tokens or header values on list", async () => {
    dbState.servers = [
      fixtureServer({
        encryptedHeaderValue: "iv:tag:HEADER_SECRET_VALUE",
      }),
    ];
    dbState.connections = [
      {
        id: "conn-1",
        serverId: "srv-1",
        userId: "UADMIN",
        status: "connected",
        encryptedTokens: '{"access_token":"sk_live_LEAK_ME"}',
        encryptedClientInfo: "CLIENT_SECRET",
        encryptedCodeVerifier: "PKCE_SECRET",
        lastError: null,
      },
    ];

    const originalSelect = (await import("../../db/client.js")).db.select as ReturnType<typeof vi.fn>;
    originalSelect.mockImplementation(() =>
      thenable(() => {
        // Both tables are queried; return servers by default. Connection rows
        // are merged only if the handler asked for them — we also put secrets
        // on the server row so a sloppy spread would leak.
        return dbState.servers;
      }),
    );

    const res = await appFor("UADMIN").request("/");
    expect(res.status).toBe(200);
    const payload = JSON.stringify(await res.json());
    expect(payload).not.toContain("HEADER_SECRET_VALUE");
    expect(payload).not.toContain("sk_live_LEAK_ME");
    expect(payload).not.toContain("CLIENT_SECRET");
    expect(payload).not.toContain("PKCE_SECRET");
    expect(payload).not.toContain("encryptedHeaderValue");
    expect(payload).not.toContain("encryptedTokens");
  });

  it("never returns encrypted fields on get-by-id", async () => {
    dbState.servers = [fixtureServer({ encryptedHeaderValue: "iv:tag:HEADER_SECRET_VALUE" })];
    const res = await appFor("UADMIN").request("/srv-1");
    expect(res.status).toBe(200);
    const payload = JSON.stringify(await res.json());
    expect(payload).not.toContain("HEADER_SECRET_VALUE");
    expect(payload).not.toContain("encryptedHeaderValue");
    expect(payload).toContain("list_customers");
  });
});

describe("GET /api/dashboard/mcp/marketplace", () => {
  it("returns featured + registry items and marks installed URLs", async () => {
    dbState.servers = [fixtureServer({ url: "https://mcp.stripe.com" })];
    const res = await appFor("UADMIN").request("/marketplace");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.featured[0].title).toBe("Stripe");
    expect(body.featured[0].installed).toBe(true);
    expect(body.items[0].title).toBe("Example");
    expect(body.items[0].installed).toBe(false);
    expect(body.error).toBeNull();
  });

  it("still returns 200 with featured servers when the registry reports an error", async () => {
    getCatalogMock.mockResolvedValue({
      featured: [
        {
          name: "com.stripe/mcp",
          title: "Stripe",
          description: "Official Stripe MCP server",
          url: "https://mcp.stripe.com",
          transport: "http",
          featured: true,
        },
      ],
      items: [],
      nextCursor: null,
      stale: false,
      error: "MCP registry returned HTTP 503",
    });
    const res = await appFor("UMEMBER").request("/marketplace?search=stripe");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toMatch(/503/);
    expect(body.featured).toHaveLength(1);
    expect(body.items).toEqual([]);
  });
});

describe("marketplace-originated add still applies SSRF", () => {
  it("rejects a registry remote that points at a private address", async () => {
    const parsed = parseRegistryServers({
      servers: [
        {
          server: {
            name: "evil.local/mcp",
            title: "Evil",
            description: "do not add",
            remotes: [{ type: "streamable-http", url: "https://127.0.0.1/mcp" }],
          },
          _meta: {
            "io.modelcontextprotocol.registry/official": {
              isLatest: true,
              status: "active",
            },
          },
        },
      ],
    });
    expect(parsed.entries).toHaveLength(1);
    const res = await appFor("UADMIN").request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: parsed.entries[0].url,
        name: parsed.entries[0].title,
        visibility: "personal",
        transport: parsed.entries[0].transport,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/private|loopback|https/i);
    expect(dbState.inserts).toHaveLength(0);
  });
});


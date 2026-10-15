import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  allowedCachedTools,
  canManageMcpServer,
  canViewMcpServer,
  mcpConnectionStatus,
  redactSensitive,
  selectLiveMcpServersForCaller,
  toMcpServerDto,
} from "./mcp-servers.js";
import type { McpConnection, McpServer } from "@aura/db/schema";

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "srv-1",
    workspaceId: "default",
    slug: "stripe",
    name: "Stripe",
    url: "https://mcp.stripe.com/mcp",
    transport: "http",
    authType: "none",
    headerName: null,
    encryptedHeaderValue: null,
    visibility: "personal",
    ownerId: "U1",
    enabled: true,
    trusted: false,
    hint: null,
    cachedInstructions: null,
    instructionsCachedAt: null,
    deniedTools: [],
    cachedTools: [
      { name: "list_customers", description: "List" },
      { name: "create_refund", description: "Refund" },
    ],
    toolsCachedAt: new Date("2026-10-12T00:00:00.000Z"),
    createdBy: "U1",
    createdAt: new Date("2026-10-12T00:00:00.000Z"),
    updatedAt: new Date("2026-10-12T00:00:00.000Z"),
    ...overrides,
  } as McpServer;
}

describe("redactSensitive", () => {
  it("strips encrypted tokens, header values, and verifier fields", () => {
    const redacted = redactSensitive({
      id: "srv-1",
      name: "Stripe",
      encryptedHeaderValue: "iv:tag:CIPHERTEXT",
      encryptedTokens: '{"access_token":"sk_live_secret"}',
      encryptedCodeVerifier: "pkce-secret",
      headerValue: "Bearer sk_live_secret",
      accessToken: "sk_live_secret",
      nested: { refresh_token: "rt_secret", slug: "stripe" },
    });
    expect(JSON.stringify(redacted)).not.toMatch(/sk_live_secret|CIPHERTEXT|pkce-secret|rt_secret/);
    expect(redacted).toEqual({
      id: "srv-1",
      name: "Stripe",
      nested: { slug: "stripe" },
    });
  });
});

describe("toMcpServerDto", () => {
  it("never copies encrypted columns onto the public DTO", () => {
    const dto = toMcpServerDto(
      server({
        authType: "header",
        headerName: "Authorization",
        encryptedHeaderValue: "iv:tag:SUPER_SECRET_HEADER",
      }),
    );
    expect(dto.hasHeaderAuth).toBe(true);
    expect(dto.headerName).toBe("Authorization");
    expect(dto.canManage).toBe(false);
    expect(JSON.stringify(dto)).not.toContain("SUPER_SECRET_HEADER");
    expect(dto).not.toHaveProperty("encryptedHeaderValue");
  });

  it("reports needs_auth for oauth without a live connection", () => {
    expect(mcpConnectionStatus(server({ authType: "oauth" }))).toBe("needs_auth");
    expect(
      mcpConnectionStatus(server({ authType: "oauth" }), {
        status: "error",
        lastError: "boom",
      } as McpConnection),
    ).toBe("error");
  });
});

describe("allowedCachedTools + authz helpers", () => {
  it("hides denied tools from the allowed list", () => {
    const tools = allowedCachedTools(server({ deniedTools: ["create_refund"] }));
    expect(tools.map((t) => t.name)).toEqual(["list_customers"]);
  });

  it("excludes denied tools from the DTO tool count used in prompt lines", () => {
    const dto = toMcpServerDto(server({ deniedTools: ["create_refund"] }));
    expect(dto.toolCount).toBe(1);
    expect(dto.promptLine).toContain("(1 tools)");
    expect(dto.hintSource).toBe("registry");
    expect(dto.effectiveHint).toBe("Stripe");
  });

  it("lets members view workspace servers but not manage them", () => {
    const workspace = server({ visibility: "workspace", ownerId: "UADMIN" });
    expect(canViewMcpServer(workspace, "UMEMBER", false)).toBe(true);
    expect(canManageMcpServer(workspace, "UMEMBER", false)).toBe(false);
    expect(canManageMcpServer(workspace, "UADMIN", true)).toBe(true);
  });

  it("lets a member manage only their own personal server", () => {
    const mine = server({ visibility: "personal", ownerId: "UMEMBER" });
    const theirs = server({ visibility: "personal", ownerId: "UOTHER" });
    expect(canManageMcpServer(mine, "UMEMBER", false)).toBe(true);
    expect(canViewMcpServer(theirs, "UMEMBER", false)).toBe(false);
    expect(canManageMcpServer(theirs, "UMEMBER", false)).toBe(false);
    expect(canManageMcpServer(theirs, "UADMIN", true)).toBe(true);
  });
});

describe("selectLiveMcpServersForCaller", () => {
  const connections = (userId: string, serverId = "srv-1") =>
    new Map([
      [
        serverId,
        {
          id: "conn-1",
          serverId,
          userId,
          status: "connected",
          encryptedTokens: "tok",
        } as McpConnection,
      ],
    ]);

  it("never includes user A's personal server in a prompt built for user B", () => {
    const personal = server({
      visibility: "personal",
      ownerId: "UA",
      authType: "oauth",
    });
    const forB = selectLiveMcpServersForCaller({
      servers: [personal],
      connections: connections("UB"),
      userId: "UB",
      isJob: false,
    });
    expect(forB).toEqual([]);

    const forA = selectLiveMcpServersForCaller({
      servers: [personal],
      connections: connections("UA"),
      userId: "UA",
      isJob: false,
    });
    expect(forA.map((s) => s.slug)).toEqual(["stripe"]);
  });

  it("hides a personal server from a job whose allowlist excludes it", () => {
    const personal = server({ visibility: "personal", ownerId: "UA", authType: "none" });
    const excluded = selectLiveMcpServersForCaller({
      servers: [personal],
      connections: new Map(),
      userId: "UA",
      isJob: true,
      envAllowlist: ["GITHUB_TOKEN"],
    });
    expect(excluded).toEqual([]);

    const allowed = selectLiveMcpServersForCaller({
      servers: [personal],
      connections: new Map(),
      userId: "UA",
      isJob: true,
      envAllowlist: ["mcp:stripe"],
    });
    expect(allowed.map((s) => s.slug)).toEqual(["stripe"]);
  });

  it("omits oauth servers that are not live for the caller even when visible", () => {
    const workspace = server({
      visibility: "workspace",
      ownerId: "UADMIN",
      authType: "oauth",
    });
    expect(
      selectLiveMcpServersForCaller({
        servers: [workspace],
        connections: new Map(),
        userId: "UMEMBER",
        isJob: false,
      }),
    ).toEqual([]);
  });

  it("sorts live servers by slug", () => {
    const closeFr = server({ id: "a", slug: "close_fr", authType: "none" });
    const closeEs = server({ id: "b", slug: "close_es", authType: "none" });
    const ordered = selectLiveMcpServersForCaller({
      servers: [closeFr, closeEs],
      connections: new Map(),
      userId: "U1",
      isJob: false,
    });
    expect(ordered.map((s) => s.slug)).toEqual(["close_es", "close_fr"]);
  });
});

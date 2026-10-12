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

import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const dbMocks = vi.hoisted(() => {
  const rows = new Map<string, Record<string, any>>();
  return {
    rows,
    selectWhere: vi.fn(),
    updateSet: vi.fn(),
    insertValues: vi.fn(),
  };
});

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: dbMocks.selectWhere,
        limit: vi.fn(async () => {
          return [];
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => ({
        where: dbMocks.updateSet.mockImplementation(async () => {
          const row = [...dbMocks.rows.values()][0];
          if (row) Object.assign(row, values);
        }),
      }),
    })),
    insert: vi.fn(() => ({
      values: dbMocks.insertValues,
    })),
  },
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./mcp-ssrf.js", () => ({
  assertPublicHttpsUrl: vi.fn(async (url: string) => new URL(url)),
}));

const TEST_KEY = crypto.randomBytes(32).toString("hex");

describe("MCP OAuth state + PKCE persistence", () => {
  beforeEach(() => {
    vi.stubEnv("CREDENTIALS_KEY", TEST_KEY);
    dbMocks.rows.clear();
    dbMocks.selectWhere.mockReset();
    dbMocks.updateSet.mockReset();
  });

  it("persists oauth state and the PKCE verifier encrypted, then reads them back", async () => {
    const connectionId = "conn-1";
    const row: Record<string, any> = {
      id: connectionId,
      workspaceId: "default",
      serverId: "srv-1",
      userId: "U123",
      status: "pending_auth",
      encryptedTokens: null,
      encryptedClientInfo: null,
      encryptedCodeVerifier: null,
      encryptedAsInfo: null,
      oauthState: null,
      dynamicallyRegistered: false,
    };
    dbMocks.rows.set(connectionId, row);

    dbMocks.selectWhere.mockImplementation(async () => [row]);
    // `.limit(1)` is chained after where in DbOAuthClientProvider.load()
    dbMocks.selectWhere.mockImplementation(() => ({
      limit: async () => [row],
    }));

    const { DbOAuthClientProvider, decryptJson } = await import("./mcp-oauth.js");
    const { decryptCredential } = await import("./credentials.js");
    const provider = new DbOAuthClientProvider(
      connectionId,
      "https://aura.test/api/mcp/oauth/callback",
    );

    const state = await provider.state();
    expect(state).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(row.oauthState).toBe(state);
    expect(await provider.storedState()).toBe(state);

    await provider.saveCodeVerifier("pkce-verifier-secret");
    expect(row.encryptedCodeVerifier).toBeTruthy();
    expect(row.encryptedCodeVerifier).not.toContain("pkce-verifier-secret");
    expect(decryptCredential(row.encryptedCodeVerifier)).toBe("pkce-verifier-secret");
    expect(await provider.codeVerifier()).toBe("pkce-verifier-secret");

    await provider.saveTokens({
      access_token: "tok_live_secret",
      refresh_token: "rt_secret",
      expires_in: 3600,
      token_type: "bearer",
    });
    expect(row.encryptedTokens).toBeTruthy();
    expect(row.encryptedTokens).not.toContain("tok_live_secret");
    expect(row.status).toBe("connected");
    const tokens = decryptJson<{ access_token: string }>(row.encryptedTokens);
    expect(tokens?.access_token).toBe("tok_live_secret");
    expect(await provider.tokens()).toEqual(
      expect.objectContaining({ access_token: "tok_live_secret" }),
    );
  });

  it("captures the authorization URL instead of redirecting", async () => {
    const row: Record<string, any> = {
      id: "conn-2",
      encryptedTokens: null,
      oauthState: "abc",
    };
    dbMocks.rows.set("conn-2", row);
    dbMocks.selectWhere.mockImplementation(() => ({
      limit: async () => [row],
    }));

    const { DbOAuthClientProvider } = await import("./mcp-oauth.js");
    const captured = { url: undefined as URL | undefined };
    const provider = new DbOAuthClientProvider(
      "conn-2",
      "https://aura.test/api/mcp/oauth/callback",
      captured,
    );

    await provider.redirectToAuthorization(
      new URL("https://auth.stripe.com/oauth/authorize?state=abc"),
    );
    expect(captured.url?.hostname).toBe("auth.stripe.com");
    expect(captured.url?.searchParams.get("state")).toBe("abc");
  });
});

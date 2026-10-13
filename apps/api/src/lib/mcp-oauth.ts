import { and, eq } from "drizzle-orm";
import type {
  OAuthAuthorizationServerInformation,
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthTokens,
} from "@ai-sdk/mcp";
import { mcpConnections, mcpServers, type McpConnection } from "@aura/db/schema";
import { db } from "../db/client.js";
import { decryptCredential, encryptCredential } from "./credentials.js";
import { logger } from "./logger.js";
import { assertPublicHttpsUrl } from "./mcp-ssrf.js";

export type McpOAuthTokens = OAuthTokens;
export type McpOAuthClientInformation = OAuthClientInformation;
export type McpOAuthAsInformation = OAuthAuthorizationServerInformation;

export function encryptJson(value: unknown): string {
  return encryptCredential(JSON.stringify(value));
}

export function decryptJson<T>(ciphertext: string | null | undefined): T | undefined {
  if (!ciphertext) return undefined;
  return JSON.parse(decryptCredential(ciphertext)) as T;
}

export function getMcpOAuthRedirectUrl(): string {
  const explicit = process.env.AURA_PUBLIC_URL?.replace(/\/+$/, "");
  if (explicit) return `${explicit}/api/mcp/oauth/callback`;

  const host =
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "localhost:3001";
  const protocol = host.includes("localhost") ? "http" : "https";
  return `${protocol}://${host}/api/mcp/oauth/callback`;
}

export interface OAuthRedirectCapture {
  url?: URL;
}

/**
 * DB-backed OAuthClientProvider. Tokens, PKCE verifier, and client info are
 * encrypted at rest. `oauth_state` is stored in plaintext so the callback can
 * look the row up (it is a CSRF nonce, not a credential).
 *
 * Implements the `@ai-sdk/mcp` OAuthClientProvider shape. The SDK's `auth()`
 * is the code-exchange entry point — see completeMcpOAuth().
 */
export class DbOAuthClientProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  readonly capturedRedirect: OAuthRedirectCapture;

  constructor(
    private readonly connectionId: string,
    redirectUrl: string = getMcpOAuthRedirectUrl(),
    capturedRedirect: OAuthRedirectCapture = {},
  ) {
    this.redirectUrl = redirectUrl;
    this.capturedRedirect = capturedRedirect;
    this.clientMetadata = {
      client_name: "Aura",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    };
  }

  private async load(): Promise<McpConnection | undefined> {
    const [row] = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.id, this.connectionId))
      .limit(1);
    return row;
  }

  private async patch(values: Partial<typeof mcpConnections.$inferInsert>): Promise<void> {
    await db
      .update(mcpConnections)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(mcpConnections.id, this.connectionId));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const row = await this.load();
    const raw = decryptJson<Partial<OAuthTokens>>(row?.encryptedTokens);
    if (!raw?.access_token) return undefined;
    return { token_type: "bearer", ...raw } as OAuthTokens;
  }

  async saveTokens(tokens: McpOAuthTokens): Promise<void> {
    const expiresAt =
      typeof tokens.expires_in === "number"
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null;
    await this.patch({
      encryptedTokens: encryptJson(tokens),
      expiresAt,
      status: "connected",
      lastError: null,
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.capturedRedirect.url = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.patch({ encryptedCodeVerifier: encryptCredential(codeVerifier) });
  }

  async codeVerifier(): Promise<string> {
    const row = await this.load();
    if (!row?.encryptedCodeVerifier) {
      throw new Error("MCP OAuth PKCE verifier is missing");
    }
    return decryptCredential(row.encryptedCodeVerifier);
  }

  async clientInformation(): Promise<McpOAuthClientInformation | undefined> {
    const row = await this.load();
    return decryptJson<McpOAuthClientInformation>(row?.encryptedClientInfo);
  }

  async saveClientInformation(clientInformation: McpOAuthClientInformation): Promise<void> {
    await this.patch({
      encryptedClientInfo: encryptJson(clientInformation),
      dynamicallyRegistered: true,
    });
  }

  async isClientInformationDynamicallyRegistered(): Promise<boolean> {
    const row = await this.load();
    return row?.dynamicallyRegistered === true;
  }

  async state(): Promise<string> {
    const row = await this.load();
    if (row?.oauthState) return row.oauthState;
    const generated = crypto.randomUUID();
    await this.saveState(generated);
    return generated;
  }

  async saveState(state: string): Promise<void> {
    await this.patch({ oauthState: state });
  }

  async storedState(): Promise<string | undefined> {
    const row = await this.load();
    return row?.oauthState ?? undefined;
  }

  async authorizationServerInformation(): Promise<McpOAuthAsInformation | undefined> {
    const row = await this.load();
    return decryptJson<McpOAuthAsInformation>(row?.encryptedAsInfo);
  }

  async saveAuthorizationServerInformation(info: McpOAuthAsInformation): Promise<void> {
    await this.patch({ encryptedAsInfo: encryptJson(info) });
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier",
    context?: { tokens?: McpOAuthTokens },
  ): Promise<void> {
    if (scope === "tokens" && context?.tokens) {
      const current = await this.tokens();
      if (
        current &&
        (current.access_token !== context.tokens.access_token ||
          current.refresh_token !== context.tokens.refresh_token)
      ) {
        return;
      }
    }

    if (scope === "all") {
      await this.patch({
        encryptedTokens: null,
        encryptedClientInfo: null,
        encryptedCodeVerifier: null,
        encryptedAsInfo: null,
        oauthState: null,
        dynamicallyRegistered: false,
        status: "expired",
      });
      return;
    }
    if (scope === "client") {
      await this.patch({
        encryptedClientInfo: null,
        dynamicallyRegistered: false,
      });
      return;
    }
    if (scope === "tokens") {
      await this.patch({ encryptedTokens: null, status: "expired" });
      return;
    }
    await this.patch({ encryptedCodeVerifier: null });
  }

  async validateAuthorizationServerURL(
    _serverUrl: string | URL,
    authorizationServerUrl: string | URL,
  ): Promise<void> {
    await assertPublicHttpsUrl(String(authorizationServerUrl));
  }
}

export async function upsertPendingConnection(opts: {
  workspaceId: string;
  serverId: string;
  userId: string;
  channelId?: string;
  threadTs?: string;
}): Promise<McpConnection> {
  const now = new Date();
  const [row] = await db
    .insert(mcpConnections)
    .values({
      workspaceId: opts.workspaceId,
      serverId: opts.serverId,
      userId: opts.userId,
      status: "pending_auth",
      channelId: opts.channelId ?? null,
      threadTs: opts.threadTs ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [mcpConnections.workspaceId, mcpConnections.serverId, mcpConnections.userId],
      set: {
        status: "pending_auth",
        channelId: opts.channelId ?? null,
        threadTs: opts.threadTs ?? null,
        lastError: null,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

export async function findConnectionByState(
  workspaceId: string | undefined,
  state: string,
): Promise<McpConnection | undefined> {
  const filters = [eq(mcpConnections.oauthState, state)];
  if (workspaceId) filters.unshift(eq(mcpConnections.workspaceId, workspaceId));
  const [row] = await db
    .select()
    .from(mcpConnections)
    .where(and(...filters))
    .limit(1);
  return row;
}

export async function findConnectionByStateAny(state: string): Promise<McpConnection | undefined> {
  const [row] = await db
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.oauthState, state))
    .limit(1);
  return row;
}

/**
 * Start the OAuth authorization-code flow. `auth()` from `@ai-sdk/mcp`
 * discovers the AS, registers the client if needed, persists PKCE via the
 * provider, and calls `redirectToAuthorization` instead of navigating.
 */
export async function startMcpOAuth(opts: {
  connectionId: string;
  serverUrl: string;
  redirectUrl?: string;
}): Promise<{ authUrl: string } | { authorized: true }> {
  const { auth } = await import("@ai-sdk/mcp");
  const captured: OAuthRedirectCapture = {};
  const provider = new DbOAuthClientProvider(
    opts.connectionId,
    opts.redirectUrl ?? getMcpOAuthRedirectUrl(),
    captured,
  );
  const result = await auth(provider, { serverUrl: opts.serverUrl });
  if (result === "AUTHORIZED") return { authorized: true };
  if (!captured.url) {
    throw new Error("MCP OAuth redirect URL was not captured");
  }
  return { authUrl: captured.url.toString() };
}

/**
 * Complete the authorization-code exchange. `@ai-sdk/mcp` exports `auth()`
 * for this — pass `authorizationCode`, `callbackState`, and `callbackIssuer`.
 */
export async function completeMcpOAuth(opts: {
  connectionId: string;
  serverUrl: string;
  authorizationCode: string;
  callbackState?: string;
  callbackIssuer?: string;
  redirectUrl?: string;
}): Promise<void> {
  const { auth } = await import("@ai-sdk/mcp");
  const provider = new DbOAuthClientProvider(
    opts.connectionId,
    opts.redirectUrl ?? getMcpOAuthRedirectUrl(),
  );
  await auth(provider, {
    serverUrl: opts.serverUrl,
    authorizationCode: opts.authorizationCode,
    callbackState: opts.callbackState,
    callbackIssuer: opts.callbackIssuer,
  });
}

export async function markConnectionError(connectionId: string, error: string): Promise<void> {
  try {
    await db
      .update(mcpConnections)
      .set({ status: "error", lastError: error, updatedAt: new Date() })
      .where(eq(mcpConnections.id, connectionId));
  } catch (e: any) {
    logger.warn("Failed to mark MCP connection error", {
      connectionId,
      error: e?.message,
    });
  }
}

export async function loadServerForConnection(connection: McpConnection) {
  const [server] = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, connection.serverId))
    .limit(1);
  return server;
}

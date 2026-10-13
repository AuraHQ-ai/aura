import { and, eq, or } from "drizzle-orm";
import {
  mcpConnections,
  mcpServers,
  type McpCachedTool,
  type McpConnection,
  type McpServer,
  type ScheduleContext,
} from "@aura/db/schema";
import { db } from "../db/client.js";
import { isMcpServerAllowlisted, slugifyMcpName } from "./mcp-names.js";
import {
  formatMcpServers,
  renderMcpServerHintLine,
  resolveMcpServerHint,
  type McpHintSource,
  type McpServerHintEntry,
} from "./mcp-hints.js";
import { hasLiveConnection } from "./mcp-runtime.js";
import { executionContext } from "./tool.js";

export const DEFAULT_MCP_WORKSPACE = "default";

export type McpConnectionStatus = "connected" | "needs_auth" | "error";

const SENSITIVE_KEY =
  /^(encrypted.*|.*token.*|.*secret.*|.*password.*|.*verifier.*|headerValue|encryptedHeaderValue)$/i;

export function mcpWorkspaceId(): string {
  return DEFAULT_MCP_WORKSPACE;
}

export async function uniqueMcpSlug(workspaceId: string, desired: string): Promise<string> {
  const existing = await db
    .select({ slug: mcpServers.slug })
    .from(mcpServers)
    .where(eq(mcpServers.workspaceId, workspaceId));
  const taken = new Set(existing.map((row) => row.slug));
  if (!taken.has(desired)) return desired;
  for (let i = 2; i < 50; i++) {
    const candidate = `${desired}_${i}`.slice(0, 48);
    if (!taken.has(candidate)) return candidate;
  }
  return `${desired}_${crypto.randomUUID().slice(0, 8)}`;
}

export function slugFromUrlOrName(url: string, name?: string): string {
  let hostname = url;
  try {
    hostname = new URL(url).hostname;
  } catch {
    /* keep url */
  }
  return slugifyMcpName(name || hostname);
}

export function displayNameFromUrlOrName(url: string, name?: string): string {
  if (name?.trim()) return name.trim();
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function isMcpUnauthorized(error: unknown): boolean {
  const err = error as { name?: string; statusCode?: number; message?: string };
  if (err?.name === "UnauthorizedError") return true;
  if (err?.statusCode === 401 || err?.statusCode === 403) return true;
  const message = (err?.message || "").toLowerCase();
  return message.includes("unauthorized") || message.includes("401");
}

export function mcpConnectionStatus(
  server: McpServer,
  connection?: McpConnection | null,
): McpConnectionStatus {
  if (connection?.status === "error") return "error";
  if (hasLiveConnection(server, connection)) return "connected";
  if (server.authType === "none") return "connected";
  return "needs_auth";
}

export function allowedCachedTools(server: McpServer): McpCachedTool[] {
  const denied = new Set(server.deniedTools ?? []);
  return (server.cachedTools ?? []).filter((tool) => !denied.has(tool.name));
}

function isJobTurn(): boolean {
  const ctx = executionContext.getStore();
  return ctx?.triggerType === "scheduled_job" || ctx?.triggerType === "autonomous";
}

export async function listVisibleMcpServers(context?: ScheduleContext): Promise<McpServer[]> {
  const workspaceId = context?.workspaceId ?? DEFAULT_MCP_WORKSPACE;
  const userId = context?.userId;
  const visibility = userId
    ? or(eq(mcpServers.visibility, "workspace"), eq(mcpServers.ownerId, userId))
    : eq(mcpServers.visibility, "workspace");

  return db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.enabled, true), visibility));
}

export async function connectionsForUser(
  workspaceId: string,
  userId: string | undefined,
): Promise<Map<string, McpConnection>> {
  if (!userId) return new Map();
  const rows = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.workspaceId, workspaceId), eq(mcpConnections.userId, userId)));
  return new Map(rows.map((row) => [row.serverId, row]));
}

/**
 * Same visibility + live-connection + job-allowlist filters as `createMcpTools`.
 * Pure so prompt-block tests can assert caller isolation without hitting the DB.
 */
export function selectLiveMcpServersForCaller(opts: {
  servers: McpServer[];
  connections: Map<string, McpConnection>;
  userId?: string;
  isJob: boolean;
  envAllowlist?: string[];
}): McpServer[] {
  return opts.servers
    .filter((server) => server.enabled)
    .filter((server) => {
      if (server.visibility === "workspace") return true;
      return Boolean(opts.userId && server.ownerId === opts.userId);
    })
    .filter((server) => {
      if (!opts.isJob) return true;
      return isMcpServerAllowlisted(server.slug, opts.envAllowlist);
    })
    .filter((server) => hasLiveConnection(server, opts.connections.get(server.id)))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Servers that are enabled, visible to this caller, AND live for them.
 * A job running as someone else never sees another user's personal connection;
 * a job without `mcp:<slug>` in env_allowlist sees none of that server's tools.
 */
export async function listLiveMcpServersForCaller(context?: ScheduleContext): Promise<McpServer[]> {
  const workspaceId = context?.workspaceId ?? DEFAULT_MCP_WORKSPACE;
  const servers = await listVisibleMcpServers(context);
  const connections = await connectionsForUser(workspaceId, context?.userId);
  return selectLiveMcpServersForCaller({
    servers,
    connections,
    userId: context?.userId,
    isJob: isJobTurn(),
    envAllowlist: executionContext.getStore()?.envAllowlist,
  });
}

export function toMcpServerHintEntry(server: McpServer): McpServerHintEntry {
  return {
    slug: server.slug,
    toolCount: allowedCachedTools(server).length,
    hint: server.hint,
    cachedInstructions: server.cachedInstructions,
    fallbackDescription: server.name,
  };
}

export async function loadMcpServersHintBlock(context?: ScheduleContext): Promise<string> {
  const live = await listLiveMcpServersForCaller(context);
  return formatMcpServers(live.map(toMcpServerHintEntry));
}

export function canViewMcpServer(
  server: McpServer,
  userId: string | undefined,
  isAdmin: boolean,
): boolean {
  if (server.visibility === "workspace") return true;
  if (isAdmin) return true;
  return Boolean(userId && server.ownerId === userId);
}

export function canManageMcpServer(
  server: McpServer,
  userId: string | undefined,
  isAdmin: boolean,
): boolean {
  if (server.visibility === "workspace") return isAdmin;
  if (isAdmin) return true;
  return Boolean(userId && server.ownerId === userId);
}

export function redactSensitive<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) continue;
      out[key] = redactSensitive(nested);
    }
    return out as T;
  }
  return value;
}

export interface McpServerDto {
  id: string;
  slug: string;
  name: string;
  url: string;
  transport: string;
  authType: string;
  headerName: string | null;
  hasHeaderAuth: boolean;
  visibility: string;
  ownerId: string | null;
  enabled: boolean;
  trusted: boolean;
  hint: string | null;
  hintSource: McpHintSource | null;
  effectiveHint: string | null;
  promptLine: string | null;
  deniedTools: string[];
  toolCount: number;
  toolsCachedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  status: McpConnectionStatus;
  connectionStatus: string | null;
  lastError: string | null;
  canManage: boolean;
}

export function toMcpServerDto(
  server: McpServer,
  connection?: McpConnection | null,
  opts?: { userId?: string; isAdmin?: boolean },
): McpServerDto {
  const hintEntry = toMcpServerHintEntry(server);
  const resolved = resolveMcpServerHint(hintEntry);
  return redactSensitive({
    id: server.id,
    slug: server.slug,
    name: server.name,
    url: server.url,
    transport: server.transport,
    authType: server.authType,
    headerName: server.headerName,
    hasHeaderAuth: Boolean(server.encryptedHeaderValue),
    visibility: server.visibility,
    ownerId: server.ownerId,
    enabled: server.enabled,
    trusted: server.trusted,
    hint: server.hint ?? null,
    hintSource: resolved.source,
    effectiveHint: resolved.text,
    promptLine: renderMcpServerHintLine(hintEntry),
    deniedTools: server.deniedTools ?? [],
    toolCount: allowedCachedTools(server).length,
    toolsCachedAt: server.toolsCachedAt,
    createdBy: server.createdBy,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    status: mcpConnectionStatus(server, connection),
    connectionStatus: connection?.status ?? null,
    lastError: connection?.lastError ?? null,
    canManage: canManageMcpServer(server, opts?.userId, opts?.isAdmin ?? false),
  });
}

export function toMcpToolDtos(server: McpServer) {
  const denied = new Set(server.deniedTools ?? []);
  return (server.cachedTools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description ?? null,
    allowed: !denied.has(tool.name),
    annotations: tool.annotations ?? null,
  }));
}

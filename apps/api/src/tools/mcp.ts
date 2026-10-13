import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { mcpServers, type ScheduleContext } from "@aura/db/schema";
import { db } from "../db/client.js";
import { defineTool, executionContext } from "../lib/tool.js";
import { hasRole } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import { loadIsolated } from "../lib/mcp-isolation.js";
import {
  assertPublicHttpsUrl,
  assertPublicHttpsUrlFollowingRedirects,
  McpSsrfError,
} from "../lib/mcp-ssrf.js";
import { completeMcpOAuth, startMcpOAuth, upsertPendingConnection } from "../lib/mcp-oauth.js";
import {
  attachMcpCloser,
  buildMcpToolStubs,
  createMcpClientForServer,
  hasLiveConnection,
  refreshMcpToolCache,
  type McpClientHandle,
} from "../lib/mcp-runtime.js";
import { getMarketplaceCatalog, normalizeMcpUrl } from "../lib/mcp-registry.js";
import {
  allowedCachedTools,
  connectionsForUser,
  displayNameFromUrlOrName,
  isMcpUnauthorized,
  listLiveMcpServersForCaller,
  listVisibleMcpServers,
  slugFromUrlOrName,
  uniqueMcpSlug,
} from "../lib/mcp-servers.js";

export { closeMcpClients, MCP_CLOSE } from "../lib/mcp-runtime.js";

function workspaceIdOf(context?: ScheduleContext): string {
  return context?.workspaceId ?? "default";
}

function isJobTurn(): boolean {
  const ctx = executionContext.getStore();
  return ctx?.triggerType === "scheduled_job" || ctx?.triggerType === "autonomous";
}

function includeManagementTools(): boolean {
  return !isJobTurn();
}

/**
 * MCP server tools + chat management tools.
 *
 * Server tools are interactive-only unless the job's env_allowlist contains
 * `mcp:<slug>`. Management tools are always omitted from jobs.
 */
export async function createMcpTools(context?: ScheduleContext) {
  const tools: Record<string, any> = {};
  const clients = new Map<string, McpClientHandle>();

  const closer = async () => {
    await Promise.all([...clients.values()].map((client) => client.close().catch(() => {})));
    clients.clear();
  };

  if (includeManagementTools()) {
    Object.assign(tools, createMcpManagementTools(context));
  }

  try {
    const live = await listLiveMcpServersForCaller(context);
    const connections = await connectionsForUser(workspaceIdOf(context), context?.userId);

    const { results, failures } = await loadIsolated(
      live,
      async (server) => {
        const connection = connections.get(server.id);
        const cachedSource =
          server.cachedTools && server.cachedTools.length > 0
            ? server.cachedTools
            : await refreshMcpToolCache(server, connection);
        const cached = allowedCachedTools({ ...server, cachedTools: cachedSource });

        const getClient = async () => {
          const existing = clients.get(server.id);
          if (existing) return existing;
          const created = await createMcpClientForServer(server, connection);
          clients.set(server.id, created);
          return created;
        };

        return buildMcpToolStubs(server, cached, getClient);
      },
      (server) => server.slug,
    );

    for (const { value } of results) {
      Object.assign(tools, value);
    }
    if (failures.length > 0) {
      logger.warn("MCP servers skipped due to timeout or error", {
        failures,
        userId: context?.userId,
      });
    }
  } catch (error: any) {
    logger.warn("createMcpTools: failed to load servers, continuing without them", {
      error: error?.message,
      userId: context?.userId,
    });
  }

  return attachMcpCloser(tools, closer);
}

function createMcpManagementTools(context?: ScheduleContext) {
  return {
    mcp_search_registry: defineTool({
      description:
        "Search the official MCP registry for remote HTTPS servers. The registry itself only substring-matches one string on the server name, so this tool splits the query into tokens, queries with the longest token, then keeps entries where every token matches name, title, description, or the derived display name (empty titles fall back to the last path segment of the registry name). Returns name, display title, truncated plain-text description, remote URL, and whether already installed for you. To connect a result, call mcp_add_server with its URL (not the registry name).",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(200)
          .describe(
            'Search text, e.g. "close crm" or "stripe". Every token must match; prefer a distinctive name token.',
          ),
      }),
      slack: {
        status: "Searching MCP registry...",
        detail: (input) => input.query,
      },
      execute: async ({ query }) => {
        const catalog = await getMarketplaceCatalog({ search: query });
        const seen = new Set<string>();
        const combined = [...catalog.featured, ...catalog.items].filter((entry) => {
          const key = entry.name.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const installedUrls = new Set(
          (await listVisibleMcpServers(context)).map((server) => normalizeMcpUrl(server.url)),
        );
        return {
          ok: true,
          query,
          results: combined.map((entry) => ({
            name: entry.name,
            title: entry.title,
            description: entry.description,
            url: entry.url,
            transport: entry.transport,
            installed: installedUrls.has(normalizeMcpUrl(entry.url)),
          })),
          next_cursor: catalog.nextCursor,
          stale: catalog.stale,
          error: catalog.error,
        };
      },
    }),

    mcp_add_server: defineTool({
      description:
        "Add an MCP server by HTTPS URL so its tools become available as mcp__<slug>__<tool>. Find a URL with mcp_search_registry first. Probes the server (SSRF-safe). Returns { status: 'connected' } or { status: 'needs_auth', auth_url } for OAuth. Default visibility is personal (any member). visibility='workspace' is admin-only. Header-auth servers are added from the dashboard (phase 2). After OAuth, click the auth URL; Aura posts back into this Slack thread when connected.",
      inputSchema: z.object({
        url: z.string().url().describe("HTTPS MCP server URL (http/stdio rejected)"),
        name: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe("Display name; defaults to the hostname"),
        visibility: z
          .enum(["personal", "workspace"])
          .optional()
          .describe("personal (default, any member) or workspace (admin-only to add)"),
      }),
      slack: {
        status: "Adding MCP server...",
        detail: (input) => input.name || input.url,
      },
      execute: async ({ url, name, visibility }) => {
        const userId = context?.userId;
        if (!userId)
          return { ok: false, error: "A signed-in user is required to add an MCP server" };

        const vis = visibility ?? "personal";
        if (vis === "workspace" && !(await hasRole(userId, "admin"))) {
          return { ok: false, error: "Only admins can add workspace-visible MCP servers" };
        }

        try {
          await assertPublicHttpsUrlFollowingRedirects(url);
        } catch (error) {
          const message = error instanceof McpSsrfError ? error.message : String(error);
          return { ok: false, error: message };
        }

        const workspaceId = workspaceIdOf(context);
        const displayName = displayNameFromUrlOrName(url, name);
        const slug = await uniqueMcpSlug(workspaceId, slugFromUrlOrName(url, name));

        const [server] = await db
          .insert(mcpServers)
          .values({
            workspaceId,
            slug,
            name: displayName,
            url,
            transport: "http",
            authType: "none",
            visibility: vis,
            ownerId: userId,
            enabled: true,
            trusted: false,
            createdBy: userId,
          })
          .returning();

        try {
          const cached = await refreshMcpToolCache(server);
          return {
            ok: true,
            status: "connected" as const,
            slug,
            name: displayName,
            tool_count: cached.length,
            tools: cached.map((t) => t.name),
          };
        } catch (error: unknown) {
          if (!isMcpUnauthorized(error)) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("mcp_add_server probe failed", { slug, error: message });
            return {
              ok: false,
              error: `Could not connect to MCP server: ${message}`,
              slug,
            };
          }

          await db
            .update(mcpServers)
            .set({ authType: "oauth", updatedAt: new Date() })
            .where(eq(mcpServers.id, server.id));

          try {
            await assertPublicHttpsUrl(url);
            const connection = await upsertPendingConnection({
              workspaceId,
              serverId: server.id,
              userId,
              channelId: context?.channelId,
              threadTs: context?.threadTs,
            });
            const oauth = await startMcpOAuth({
              connectionId: connection.id,
              serverUrl: url,
            });
            if ("authorized" in oauth) {
              return { ok: true, status: "connected" as const, slug, name: displayName };
            }
            return {
              ok: true,
              status: "needs_auth" as const,
              slug,
              name: displayName,
              auth_url: oauth.authUrl,
              message:
                "Open this URL to authorize. Aura will post in this thread when the server is connected.",
            };
          } catch (oauthError: any) {
            return {
              ok: false,
              error:
                oauthError?.message ||
                "Server requires auth but OAuth could not be started. Try again or add it as a header-auth server from the dashboard.",
              slug,
            };
          }
        }
      },
    }),

    mcp_list_servers: defineTool({
      description:
        "List MCP servers visible to you (workspace-wide plus your personal servers) with connection status, tool count, and whether tools require approval (untrusted servers).",
      inputSchema: z.object({}),
      slack: { status: "Listing MCP servers..." },
      execute: async () => {
        const workspaceId = workspaceIdOf(context);
        const servers = await listVisibleMcpServers(context);
        const connections = await connectionsForUser(workspaceId, context?.userId);
        return {
          ok: true,
          servers: servers.map((server) => {
            const connection = connections.get(server.id);
            return {
              slug: server.slug,
              name: server.name,
              url: server.url,
              visibility: server.visibility,
              auth_type: server.authType,
              trusted: server.trusted,
              enabled: server.enabled,
              tool_count: server.cachedTools?.length ?? 0,
              connection_status: hasLiveConnection(server, connection)
                ? "connected"
                : server.authType === "oauth"
                  ? (connection?.status ?? "needs_auth")
                  : "not_configured",
            };
          }),
        };
      },
    }),

    mcp_remove_server: defineTool({
      description:
        "Remove an MCP server and its stored connections. Personal servers: owner only. Workspace-visible servers: admin only. Connections (including encrypted OAuth tokens) are cascade-deleted.",
      inputSchema: z.object({
        slug: z.string().min(1).describe("Server slug from mcp_list_servers"),
      }),
      slack: {
        status: "Removing MCP server...",
        detail: (input) => input.slug,
      },
      execute: async ({ slug }) => {
        const userId = context?.userId;
        if (!userId) return { ok: false, error: "A signed-in user is required" };
        const workspaceId = workspaceIdOf(context);
        const [server] = await db
          .select()
          .from(mcpServers)
          .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.slug, slug)))
          .limit(1);
        if (!server) return { ok: false, error: `No MCP server named ${slug}` };

        if (server.visibility === "workspace") {
          if (!(await hasRole(userId, "admin"))) {
            return { ok: false, error: "Only admins can remove workspace-visible MCP servers" };
          }
        } else if (server.ownerId !== userId && !(await hasRole(userId, "admin"))) {
          return { ok: false, error: "You can only remove your own personal MCP servers" };
        }

        await db.delete(mcpServers).where(eq(mcpServers.id, server.id));
        return { ok: true, removed: slug };
      },
    }),

    mcp_reauth: defineTool({
      description:
        "Start a fresh per-user OAuth flow for an existing MCP server. Returns an auth_url to click. Aura posts back into this Slack thread when connected.",
      inputSchema: z.object({
        slug: z.string().min(1).describe("Server slug from mcp_list_servers"),
      }),
      slack: {
        status: "Starting MCP re-auth...",
        detail: (input) => input.slug,
      },
      execute: async ({ slug }) => {
        const userId = context?.userId;
        if (!userId) return { ok: false, error: "A signed-in user is required" };
        const workspaceId = workspaceIdOf(context);
        const [server] = await db
          .select()
          .from(mcpServers)
          .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.slug, slug)))
          .limit(1);
        if (!server) return { ok: false, error: `No MCP server named ${slug}` };
        if (server.visibility === "personal" && server.ownerId !== userId) {
          return { ok: false, error: "You can only re-auth your own personal MCP servers" };
        }

        try {
          await assertPublicHttpsUrl(server.url);
          const connection = await upsertPendingConnection({
            workspaceId,
            serverId: server.id,
            userId,
            channelId: context?.channelId,
            threadTs: context?.threadTs,
          });
          const oauth = await startMcpOAuth({
            connectionId: connection.id,
            serverUrl: server.url,
          });
          if ("authorized" in oauth) {
            return { ok: true, status: "connected" as const, slug };
          }
          return {
            ok: true,
            status: "needs_auth" as const,
            slug,
            auth_url: oauth.authUrl,
            message:
              "Open this URL to authorize. Aura will post in this thread when the server is connected.",
          };
        } catch (error: any) {
          return { ok: false, error: error?.message || "OAuth could not be started" };
        }
      },
    }),
  };
}

export { completeMcpOAuth };

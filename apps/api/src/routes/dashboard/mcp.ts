import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, or } from "drizzle-orm";
import type { Context } from "hono";
import { mcpConnections, mcpServers, type McpConnection, type McpServer } from "@aura/db/schema";
import { db } from "../../db/client.js";
import { encryptCredential } from "../../lib/credentials.js";
import { logger } from "../../lib/logger.js";
import { startMcpOAuth, upsertPendingConnection } from "../../lib/mcp-oauth.js";
import { createMcpClientForServer, refreshMcpToolCache } from "../../lib/mcp-runtime.js";
import {
  getMarketplaceCatalog,
  normalizeMcpUrl,
  type McpCatalogEntry,
} from "../../lib/mcp-registry.js";
import {
  canManageMcpServer,
  canViewMcpServer,
  displayNameFromUrlOrName,
  isMcpUnauthorized,
  mcpWorkspaceId,
  redactSensitive,
  slugFromUrlOrName,
  toMcpServerDto,
  toMcpToolDtos,
  uniqueMcpSlug,
} from "../../lib/mcp-servers.js";
import {
  assertPublicHttpsUrl,
  assertPublicHttpsUrlFollowingRedirects,
  McpSsrfError,
} from "../../lib/mcp-ssrf.js";
import { hasRole } from "../../lib/permissions.js";
import { createDashboardApp, errorSchema, idParamSchema, okSchema } from "./schemas.js";

export const dashboardMcpApp = createDashboardApp();

function getUserId(c: Context): string | undefined {
  return c.get("userId" as never) as string | undefined;
}

async function viewer(c: Context): Promise<{ userId: string | undefined; isAdmin: boolean }> {
  const userId = getUserId(c);
  // API-secret calls have no userId; treat as admin so ops scripts still work.
  const isAdmin = userId ? await hasRole(userId, "admin") : true;
  return { userId, isAdmin };
}

function jsonSafe<T>(value: T): T {
  return redactSensitive(value);
}

function errorJson(c: Context, status: 400 | 403 | 404 | 500, error: string) {
  return c.json({ error }, status) as any;
}

async function loadServer(id: string): Promise<McpServer | undefined> {
  const [server] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.workspaceId, mcpWorkspaceId()), eq(mcpServers.id, id)))
    .limit(1);
  return server;
}

async function loadViewerConnection(
  serverId: string,
  userId: string | undefined,
): Promise<McpConnection | undefined> {
  if (!userId) return undefined;
  const [connection] = await db
    .select()
    .from(mcpConnections)
    .where(
      and(
        eq(mcpConnections.workspaceId, mcpWorkspaceId()),
        eq(mcpConnections.serverId, serverId),
        eq(mcpConnections.userId, userId),
      ),
    )
    .limit(1);
  return connection;
}

type LoadedServer =
  | { ok: true; server: McpServer; userId: string | undefined; isAdmin: boolean }
  | { ok: false; status: 403 | 404; error: string };

async function requireVisibleServer(c: Context, id: string): Promise<LoadedServer> {
  const { userId, isAdmin } = await viewer(c);
  const server = await loadServer(id);
  if (!server || !canViewMcpServer(server, userId, isAdmin)) {
    return { ok: false, status: 404, error: "Not found" };
  }
  return { ok: true, server, userId, isAdmin };
}

async function requireManagedServer(c: Context, id: string): Promise<LoadedServer> {
  const loaded = await requireVisibleServer(c, id);
  if (!loaded.ok) return loaded;
  if (!canManageMcpServer(loaded.server, loaded.userId, loaded.isAdmin)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return loaded;
}

const mcpServerDtoSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  url: z.string(),
  transport: z.string(),
  authType: z.string(),
  headerName: z.string().nullable(),
  hasHeaderAuth: z.boolean(),
  visibility: z.string(),
  ownerId: z.string().nullable(),
  enabled: z.boolean(),
  trusted: z.boolean(),
  hint: z.string().nullable(),
  hintSource: z.enum(["hint", "instructions", "registry"]).nullable(),
  effectiveHint: z.string().nullable(),
  promptLine: z.string().nullable(),
  deniedTools: z.array(z.string()),
  toolCount: z.number(),
  toolsCachedAt: z.any(),
  createdBy: z.string().nullable(),
  createdAt: z.any(),
  updatedAt: z.any(),
  status: z.enum(["connected", "needs_auth", "error"]),
  connectionStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  canManage: z.boolean(),
});

const createMcpServerBody = z.object({
  url: z.string().url(),
  name: z.string().min(1).max(80).optional(),
  visibility: z.enum(["personal", "workspace"]).optional(),
  transport: z.enum(["http", "sse"]).optional(),
  headerName: z.string().min(1).max(80).optional(),
  headerValue: z.string().min(1).optional(),
});

const mcpCatalogEntrySchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  url: z.string(),
  transport: z.enum(["http", "sse"]),
  featured: z.boolean(),
  installed: z.boolean(),
  installedServerId: z.string().nullable(),
});

function withInstalledState(entries: McpCatalogEntry[], installedByUrl: Map<string, string>) {
  return entries.map((entry) => {
    const installedServerId = installedByUrl.get(normalizeMcpUrl(entry.url)) ?? null;
    return {
      ...entry,
      installed: Boolean(installedServerId),
      installedServerId,
    };
  });
}

const listMcpRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["MCP"],
  summary: "List MCP servers visible to the current user",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(mcpServerDtoSchema),
            total: z.number(),
            viewer: z.object({
              userId: z.string().nullable(),
              isAdmin: z.boolean(),
            }),
          }),
        },
      },
      description: "Success",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardMcpApp.openapi(listMcpRoute, async (c) => {
  try {
    const { userId, isAdmin } = await viewer(c);
    const workspaceId = mcpWorkspaceId();
    const visibility = isAdmin
      ? undefined
      : userId
        ? or(eq(mcpServers.visibility, "workspace"), eq(mcpServers.ownerId, userId))
        : eq(mcpServers.visibility, "workspace");

    const servers = await db
      .select()
      .from(mcpServers)
      .where(
        visibility
          ? and(eq(mcpServers.workspaceId, workspaceId), visibility)
          : eq(mcpServers.workspaceId, workspaceId),
      )
      .orderBy(desc(mcpServers.createdAt));

    const connections = userId
      ? await db
          .select()
          .from(mcpConnections)
          .where(
            and(eq(mcpConnections.workspaceId, workspaceId), eq(mcpConnections.userId, userId)),
          )
      : [];
    const byServer = new Map(connections.map((row) => [row.serverId, row]));

    const items = servers.map((server) =>
      toMcpServerDto(server, byServer.get(server.id), { userId, isAdmin }),
    );
    return c.json(
      jsonSafe({
        items,
        total: items.length,
        viewer: { userId: userId ?? null, isAdmin },
      }) as any,
      200,
    );
  } catch (error) {
    logger.error("Failed to list MCP servers", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const marketplaceQuery = z.object({
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().optional(),
});

const marketplaceRoute = createRoute({
  method: "get",
  path: "/marketplace",
  tags: ["MCP"],
  summary: "List pinned and official-registry MCP servers",
  request: { query: marketplaceQuery },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            featured: z.array(mcpCatalogEntrySchema),
            items: z.array(mcpCatalogEntrySchema),
            nextCursor: z.string().nullable(),
            stale: z.boolean(),
            error: z.string().nullable(),
          }),
        },
      },
      description: "Success",
    },
  },
});

dashboardMcpApp.openapi(marketplaceRoute, async (c) => {
  const query = c.req.valid("query");
  try {
    const { userId, isAdmin } = await viewer(c);
    let installedByUrl = new Map<string, string>();
    try {
      const workspaceId = mcpWorkspaceId();
      const visibility = isAdmin
        ? undefined
        : userId
          ? or(eq(mcpServers.visibility, "workspace"), eq(mcpServers.ownerId, userId))
          : eq(mcpServers.visibility, "workspace");
      const servers = await db
        .select({ id: mcpServers.id, url: mcpServers.url })
        .from(mcpServers)
        .where(
          visibility
            ? and(eq(mcpServers.workspaceId, workspaceId), visibility)
            : eq(mcpServers.workspaceId, workspaceId),
        );
      installedByUrl = new Map(servers.map((server) => [normalizeMcpUrl(server.url), server.id]));
    } catch (error) {
      logger.warn("Failed to load installed MCP servers for marketplace", {
        error: String(error),
      });
    }

    const catalog = await getMarketplaceCatalog({
      search: query.search,
      cursor: query.cursor,
      limit: query.limit,
    });

    return c.json(
      jsonSafe({
        featured: withInstalledState(catalog.featured, installedByUrl),
        items: withInstalledState(catalog.items, installedByUrl),
        nextCursor: catalog.nextCursor,
        stale: catalog.stale,
        error: catalog.error,
      }) as any,
      200,
    );
  } catch (error) {
    logger.error("Failed to load MCP marketplace", { error: String(error) });
    return c.json(
      {
        featured: [],
        items: [],
        nextCursor: null,
        stale: false,
        error: error instanceof Error ? error.message : String(error),
      } as any,
      200,
    );
  }
});

const createMcpRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["MCP"],
  summary: "Add an MCP server by URL",
  request: {
    body: {
      content: { "application/json": { schema: createMcpServerBody } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.any() } },
      description: "Created",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid request or SSRF rejection",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Forbidden",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardMcpApp.openapi(createMcpRoute, async (c) => {
  try {
    const { userId, isAdmin } = await viewer(c);
    const body = c.req.valid("json");
    const visibility = body.visibility ?? "personal";

    if (visibility === "workspace" && !isAdmin) {
      return c.json({ error: "Only admins can add workspace-visible MCP servers" }, 403);
    }
    if (visibility === "personal" && !userId) {
      return c.json({ error: "A signed-in user is required to add a personal MCP server" }, 400);
    }
    if (body.headerName && !body.headerValue) {
      return c.json({ error: "headerValue is required when headerName is set" }, 400);
    }
    if (body.headerValue && !body.headerName) {
      return c.json({ error: "headerName is required when headerValue is set" }, 400);
    }

    try {
      await assertPublicHttpsUrlFollowingRedirects(body.url);
    } catch (error) {
      const message = error instanceof McpSsrfError ? error.message : String(error);
      return c.json({ error: message }, 400);
    }

    const workspaceId = mcpWorkspaceId();
    const displayName = displayNameFromUrlOrName(body.url, body.name);
    const slug = await uniqueMcpSlug(workspaceId, slugFromUrlOrName(body.url, body.name));
    const headerAuth = Boolean(body.headerName && body.headerValue);

    const [server] = await db
      .insert(mcpServers)
      .values({
        workspaceId,
        slug,
        name: displayName,
        url: body.url,
        transport: body.transport ?? "http",
        authType: headerAuth ? "header" : "none",
        headerName: headerAuth ? body.headerName : null,
        encryptedHeaderValue: headerAuth ? encryptCredential(body.headerValue!) : null,
        visibility,
        ownerId: userId ?? null,
        enabled: true,
        trusted: false,
        deniedTools: [],
        createdBy: userId ?? null,
      })
      .returning();

    const created = async (extra: Record<string, unknown> = {}) =>
      c.json(
        jsonSafe({
          ...toMcpServerDto(server, undefined, { userId, isAdmin }),
          ...extra,
        }) as any,
        201,
      );

    try {
      const cached = await refreshMcpToolCache(server);
      return created({
        status: "connected",
        toolCount: cached.length,
        tools: cached.map((tool) => tool.name),
      });
    } catch (error: unknown) {
      if (headerAuth || !isMcpUnauthorized(error)) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("MCP dashboard add probe failed", { slug, error: message });
        return created({
          status: headerAuth ? "error" : "error",
          lastError: message,
        });
      }

      await db
        .update(mcpServers)
        .set({ authType: "oauth", updatedAt: new Date() })
        .where(eq(mcpServers.id, server.id));
      const oauthServer = { ...server, authType: "oauth" };

      if (!userId) {
        return created({
          ...toMcpServerDto(oauthServer, undefined, { userId, isAdmin }),
          status: "needs_auth",
        });
      }

      try {
        await assertPublicHttpsUrl(body.url);
        const connection = await upsertPendingConnection({
          workspaceId,
          serverId: server.id,
          userId,
        });
        const oauth = await startMcpOAuth({
          connectionId: connection.id,
          serverUrl: body.url,
        });
        if ("authorized" in oauth) {
          return created({
            ...toMcpServerDto(oauthServer, connection, { userId, isAdmin }),
            status: "connected",
          });
        }
        return created({
          ...toMcpServerDto(oauthServer, connection, { userId, isAdmin }),
          status: "needs_auth",
          authUrl: oauth.authUrl,
        });
      } catch (oauthError: any) {
        return created({
          ...toMcpServerDto(oauthServer, undefined, { userId, isAdmin }),
          status: "needs_auth",
          lastError: oauthError?.message || "OAuth could not be started",
        });
      }
    }
  } catch (error) {
    logger.error("Failed to add MCP server", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const getMcpRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["MCP"],
  summary: "Get an MCP server and its tools",
  request: { params: idParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardMcpApp.openapi(getMcpRoute, async (c) => {
  try {
    const loaded = await requireVisibleServer(c, c.req.param("id"));
    if (!loaded.ok) return errorJson(c, loaded.status, loaded.error);
    const connection = await loadViewerConnection(loaded.server.id, loaded.userId);
    return c.json(
      jsonSafe({
        ...toMcpServerDto(loaded.server, connection, {
          userId: loaded.userId,
          isAdmin: loaded.isAdmin,
        }),
        tools: toMcpToolDtos(loaded.server),
      }) as any,
      200,
    );
  } catch (error) {
    logger.error("Failed to get MCP server", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const updateMcpBody = z.object({
  name: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  hint: z.string().max(300).nullable().optional(),
  deniedTools: z.array(z.string().min(1)).optional(),
  headerName: z.string().min(1).max(80).optional(),
  headerValue: z.string().min(1).optional(),
});

const updateMcpRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["MCP"],
  summary: "Update an MCP server",
  request: {
    params: idParamSchema,
    body: {
      content: { "application/json": { schema: updateMcpBody } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid request",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Forbidden",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardMcpApp.openapi(updateMcpRoute, async (c) => {
  try {
    const loaded = await requireManagedServer(c, c.req.param("id"));
    if (!loaded.ok) return errorJson(c, loaded.status, loaded.error);
    const body = c.req.valid("json");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.hint !== undefined) {
      const trimmed = body.hint?.trim() ?? "";
      if (trimmed.length > 300) return errorJson(c, 400, "hint must be at most 300 characters");
      patch.hint = trimmed || null;
    }
    if (body.deniedTools !== undefined) patch.deniedTools = body.deniedTools;
    if (body.headerName !== undefined || body.headerValue !== undefined) {
      patch.authType = "header";
      if (body.headerName !== undefined) patch.headerName = body.headerName;
      if (body.headerValue !== undefined) {
        patch.encryptedHeaderValue = encryptCredential(body.headerValue);
      }
    }

    const [updated] = await db
      .update(mcpServers)
      .set(patch)
      .where(eq(mcpServers.id, loaded.server.id))
      .returning();
    const connection = await loadViewerConnection(updated.id, loaded.userId);
    return c.json(
      jsonSafe(
        toMcpServerDto(updated, connection, { userId: loaded.userId, isAdmin: loaded.isAdmin }),
      ) as any,
      200,
    );
  } catch (error) {
    logger.error("Failed to update MCP server", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const deleteMcpRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["MCP"],
  summary: "Remove an MCP server",
  request: { params: idParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: okSchema } },
      description: "Success",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Forbidden",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Error",
    },
  },
});

dashboardMcpApp.openapi(deleteMcpRoute, async (c) => {
  try {
    const loaded = await requireManagedServer(c, c.req.param("id"));
    if (!loaded.ok) return errorJson(c, loaded.status, loaded.error);
    await db.delete(mcpServers).where(eq(mcpServers.id, loaded.server.id));
    return c.json({ ok: true } as any, 200);
  } catch (error) {
    logger.error("Failed to delete MCP server", { error: String(error) });
    return c.json({ error: "Internal server error" }, 500);
  }
});

const enabledBody = z.object({ enabled: z.boolean() });

const toggleEnabledRoute = createRoute({
  method: "patch",
  path: "/{id}/enabled",
  tags: ["MCP"],
  summary: "Enable or disable an MCP server",
  request: {
    params: idParamSchema,
    body: { content: { "application/json": { schema: enabledBody } }, required: true },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Forbidden",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
  },
});

dashboardMcpApp.openapi(toggleEnabledRoute, async (c) => {
  const loaded = await requireManagedServer(c, c.req.param("id"));
  if (!loaded.ok) return errorJson(c, loaded.status, loaded.error);
  const { enabled } = c.req.valid("json");
  const [updated] = await db
    .update(mcpServers)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(mcpServers.id, loaded.server.id))
    .returning();
  const connection = await loadViewerConnection(updated.id, loaded.userId);
  return c.json(
    jsonSafe(
      toMcpServerDto(updated, connection, { userId: loaded.userId, isAdmin: loaded.isAdmin }),
    ) as any,
    200,
  );
});

const trustedBody = z.object({ trusted: z.boolean() });

const toggleTrustedRoute = createRoute({
  method: "patch",
  path: "/{id}/trusted",
  tags: ["MCP"],
  summary: "Mark an MCP server trusted (admin only)",
  request: {
    params: idParamSchema,
    body: { content: { "application/json": { schema: trustedBody } }, required: true },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Forbidden",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
  },
});

dashboardMcpApp.openapi(toggleTrustedRoute, async (c) => {
  const loaded = await requireVisibleServer(c, c.req.param("id"));
  if (!loaded.ok) return errorJson(c, loaded.status, loaded.error);
  if (!loaded.isAdmin) {
    return c.json({ error: "Only admins can mark an MCP server trusted" }, 403);
  }
  const { trusted } = c.req.valid("json");
  const [updated] = await db
    .update(mcpServers)
    .set({ trusted, updatedAt: new Date() })
    .where(eq(mcpServers.id, loaded.server.id))
    .returning();
  const connection = await loadViewerConnection(updated.id, loaded.userId);
  return c.json(
    jsonSafe(
      toMcpServerDto(updated, connection, { userId: loaded.userId, isAdmin: loaded.isAdmin }),
    ) as any,
    200,
  );
});

const toolAllowBody = z.object({
  tool: z.string().min(1).optional(),
  allowed: z.boolean().optional(),
  deniedTools: z.array(z.string().min(1)).optional(),
});

const updateToolsRoute = createRoute({
  method: "patch",
  path: "/{id}/tools",
  tags: ["MCP"],
  summary: "Allow or deny MCP tools on a server",
  request: {
    params: idParamSchema,
    body: { content: { "application/json": { schema: toolAllowBody } }, required: true },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid request",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Forbidden",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
  },
});

dashboardMcpApp.openapi(updateToolsRoute, async (c) => {
  const loaded = await requireManagedServer(c, c.req.param("id"));
  if (!loaded.ok) return errorJson(c, loaded.status, loaded.error);
  const body = c.req.valid("json");

  let deniedTools = [...(loaded.server.deniedTools ?? [])];
  if (body.deniedTools) {
    deniedTools = [...new Set(body.deniedTools)];
  } else if (body.tool && body.allowed !== undefined) {
    const denied = new Set(deniedTools);
    if (body.allowed) denied.delete(body.tool);
    else denied.add(body.tool);
    deniedTools = [...denied];
  } else {
    return c.json({ error: "Provide deniedTools or tool + allowed" }, 400);
  }

  const [updated] = await db
    .update(mcpServers)
    .set({ deniedTools, updatedAt: new Date() })
    .where(eq(mcpServers.id, loaded.server.id))
    .returning();
  const connection = await loadViewerConnection(updated.id, loaded.userId);
  return c.json(
    jsonSafe({
      ...toMcpServerDto(updated, connection, { userId: loaded.userId, isAdmin: loaded.isAdmin }),
      tools: toMcpToolDtos(updated),
    }) as any,
    200,
  );
});

const listToolsRoute = createRoute({
  method: "get",
  path: "/{id}/tools",
  tags: ["MCP"],
  summary: "List tools for an MCP server",
  request: { params: idParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
  },
});

dashboardMcpApp.openapi(listToolsRoute, async (c) => {
  const loaded = await requireVisibleServer(c, c.req.param("id"));
  if (!loaded.ok) return errorJson(c, loaded.status, loaded.error);
  return c.json(
    jsonSafe({
      tools: toMcpToolDtos(loaded.server),
      deniedTools: loaded.server.deniedTools ?? [],
    }) as any,
    200,
  );
});

const authMcpRoute = createRoute({
  method: "post",
  path: "/{id}/auth",
  tags: ["MCP"],
  summary: "Start or restart OAuth for an MCP server",
  request: { params: idParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid request",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "Forbidden",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
  },
});

dashboardMcpApp.openapi(authMcpRoute, async (c) => {
  const loaded = await requireVisibleServer(c, c.req.param("id"));
  if (!loaded.ok) return errorJson(c, loaded.status, loaded.error);
  if (!loaded.userId) {
    return c.json({ error: "A signed-in user is required to start MCP OAuth" }, 400);
  }
  if (
    loaded.server.visibility === "personal" &&
    loaded.server.ownerId !== loaded.userId &&
    !loaded.isAdmin
  ) {
    return c.json({ error: "Forbidden" }, 403);
  }

  try {
    await assertPublicHttpsUrl(loaded.server.url);
    const connection = await upsertPendingConnection({
      workspaceId: mcpWorkspaceId(),
      serverId: loaded.server.id,
      userId: loaded.userId,
    });
    const oauth = await startMcpOAuth({
      connectionId: connection.id,
      serverUrl: loaded.server.url,
    });
    if ("authorized" in oauth) {
      return c.json(
        jsonSafe({
          ...toMcpServerDto(
            loaded.server,
            { ...connection, status: "connected" },
            { userId: loaded.userId, isAdmin: loaded.isAdmin },
          ),
          status: "connected",
        }) as any,
        200,
      );
    }
    return c.json(
      jsonSafe({
        ...toMcpServerDto(loaded.server, connection, {
          userId: loaded.userId,
          isAdmin: loaded.isAdmin,
        }),
        status: "needs_auth",
        authUrl: oauth.authUrl,
      }) as any,
      200,
    );
  } catch (error: any) {
    return c.json({ error: error?.message || "OAuth could not be started" }, 400);
  }
});

const testMcpRoute = createRoute({
  method: "post",
  path: "/{id}/test",
  tags: ["MCP"],
  summary: "Test the connection to an MCP server",
  request: { params: idParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
  },
});

dashboardMcpApp.openapi(testMcpRoute, async (c) => {
  const loaded = await requireVisibleServer(c, c.req.param("id"));
  if (!loaded.ok) return errorJson(c, loaded.status, loaded.error);
  const connection = await loadViewerConnection(loaded.server.id, loaded.userId);
  try {
    const client = await createMcpClientForServer(loaded.server, connection);
    try {
      const remote = await client.tools();
      return c.json(
        jsonSafe({
          ok: true,
          status: "connected",
          toolCount: Object.keys(remote).length,
        }) as any,
        200,
      );
    } finally {
      await client.close().catch(() => {});
    }
  } catch (error: any) {
    const message = error?.message || String(error);
    return c.json(
      jsonSafe({
        ok: false,
        status: isMcpUnauthorized(error) ? "needs_auth" : "error",
        error: message,
      }) as any,
      200,
    );
  }
});

const refreshMcpRoute = createRoute({
  method: "post",
  path: "/{id}/refresh",
  tags: ["MCP"],
  summary: "Refresh the cached tool list for an MCP server",
  request: { params: idParamSchema },
  responses: {
    200: {
      content: { "application/json": { schema: z.any() } },
      description: "Success",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Refresh failed",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Not found",
    },
  },
});

dashboardMcpApp.openapi(refreshMcpRoute, async (c) => {
  const loaded = await requireManagedServer(c, c.req.param("id"));
  if (!loaded.ok) return errorJson(c, loaded.status, loaded.error);
  const connection = await loadViewerConnection(loaded.server.id, loaded.userId);
  try {
    const cached = await refreshMcpToolCache(loaded.server, connection);
    const [updated] = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, loaded.server.id))
      .limit(1);
    return c.json(
      jsonSafe({
        ...toMcpServerDto(updated ?? { ...loaded.server, cachedTools: cached }, connection, {
          userId: loaded.userId,
          isAdmin: loaded.isAdmin,
        }),
        tools: toMcpToolDtos(updated ?? { ...loaded.server, cachedTools: cached }),
      }) as any,
      200,
    );
  } catch (error: any) {
    return c.json({ error: error?.message || "Could not refresh MCP tools" }, 400);
  }
});

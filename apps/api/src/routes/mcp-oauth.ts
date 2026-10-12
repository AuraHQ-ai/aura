import { Hono } from "hono";
import { WebClient } from "@slack/web-api";
import { eq } from "drizzle-orm";
import { mcpConnections } from "@aura/db/schema";
import { db } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { safePostMessage } from "../lib/slack-messaging.js";
import {
  completeMcpOAuth,
  findConnectionByStateAny,
  loadServerForConnection,
  markConnectionError,
} from "../lib/mcp-oauth.js";
import {
  createMcpClientForServer,
  persistCachedTools,
  cachedToolsFromRemote,
} from "../lib/mcp-runtime.js";

function htmlPage(title: string, body: string, ok: boolean): string {
  const color = ok ? "#0a7" : "#c33";
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${title}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 3rem auto; max-width: 32rem; color: #111; }
  h1 { color: ${color}; font-size: 1.25rem; }
  p { line-height: 1.5; }
</style></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;
}

export function createMcpOAuthApp(slackClient?: WebClient) {
  const app = new Hono();
  const client = slackClient ?? new WebClient(process.env.SLACK_BOT_TOKEN || "");

  app.get("/callback", async (c) => {
    const error = c.req.query("error");
    const errorDescription = c.req.query("error_description");
    const code = c.req.query("code");
    const state = c.req.query("state");
    const iss = c.req.query("iss");

    if (error) {
      return c.html(
        htmlPage(
          "MCP authorization failed",
          errorDescription || error,
          false,
        ),
        400,
      );
    }
    if (!code || !state) {
      return c.html(
        htmlPage("MCP authorization failed", "Missing code or state.", false),
        400,
      );
    }

    const connection = await findConnectionByStateAny(state);
    if (!connection) {
      return c.html(
        htmlPage(
          "MCP authorization failed",
          "Unknown or expired OAuth state. Ask Aura to run mcp_reauth.",
          false,
        ),
        400,
      );
    }

    const server = await loadServerForConnection(connection);
    if (!server) {
      return c.html(
        htmlPage("MCP authorization failed", "The MCP server no longer exists.", false),
        404,
      );
    }

    try {
      await completeMcpOAuth({
        connectionId: connection.id,
        serverUrl: server.url,
        authorizationCode: code,
        callbackState: state,
        callbackIssuer: iss,
      });

      try {
        const handle = await createMcpClientForServer(server, {
          ...connection,
          status: "connected",
        });
        try {
          const remote = await handle.tools();
          await persistCachedTools(server.id, cachedToolsFromRemote(remote));
        } finally {
          await handle.close().catch(() => {});
        }
      } catch (cacheError: any) {
        logger.warn("MCP tool cache refresh after OAuth failed", {
          slug: server.slug,
          error: cacheError?.message,
        });
      }

      await db
        .update(mcpConnections)
        .set({ oauthState: null, status: "connected", lastError: null, updatedAt: new Date() })
        .where(eq(mcpConnections.id, connection.id));

      if (connection.channelId) {
        await safePostMessage(client, {
          channel: connection.channelId,
          text: `Connected to MCP server *${server.name}* (\`${server.slug}\`). Tools are available as \`mcp__${server.slug}__*\` in this thread.`,
          ...(connection.threadTs ? { thread_ts: connection.threadTs } : {}),
        });
      }

      return c.html(
        htmlPage(
          "Connected",
          `Aura is now connected to ${server.name}. You can close this tab and return to Slack.`,
          true,
        ),
      );
    } catch (err: any) {
      const message = err?.message || "Token exchange failed";
      logger.error("MCP OAuth callback failed", {
        connectionId: connection.id,
        error: message,
      });
      await markConnectionError(connection.id, message);
      if (connection.channelId) {
        await safePostMessage(client, {
          channel: connection.channelId,
          text: `MCP OAuth for *${server.name}* failed: ${message}`,
          ...(connection.threadTs ? { thread_ts: connection.threadTs } : {}),
        });
      }
      return c.html(htmlPage("MCP authorization failed", message, false), 500);
    }
  });

  return app;
}

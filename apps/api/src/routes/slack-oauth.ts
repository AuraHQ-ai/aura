import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { workspaces } from "@aura/db/schema";
import { logger } from "../lib/logger.js";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SCOPES = [
  "assistant:write",
  "chat:write",
  "app_mentions:read",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:read",
  "im:history",
  "im:write",
  "mpim:read",
  "mpim:history",
  "users:read",
  "reactions:read",
  "reactions:write",
  "files:read",
  "files:write",
  "team:read",
  "channels:join",
].join(",");

function getRedirectUri(): string {
  const explicit = process.env.SLACK_OAUTH_REDIRECT_URI;
  if (explicit) {
    return explicit;
  }
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (host?.startsWith("http")) {
    return `${host}/api/slack/oauth-callback`;
  }
  if (host) {
    return `https://${host}/api/slack/oauth-callback`;
  }
  return "https://aura-alpha-five.vercel.app/api/slack/oauth-callback";
}

export const slackOAuthApp = new Hono();

// ── Install: redirect to Slack consent page ─────────────────────────────────

slackOAuthApp.get("/install", (c) => {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    logger.error("SLACK_CLIENT_ID not configured — cannot start OAuth flow");
    return c.json({ error: "OAuth not configured" }, 500);
  }

  const state = crypto.randomUUID();
  setCookie(c, "slack_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/api/slack",
    maxAge: 600,
  });

  const redirectUri = getRedirectUri();
  const authorizeUrl = new URL("https://slack.com/oauth/v2/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("scope", SCOPES);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);

  return c.redirect(authorizeUrl.toString());
});

// ── Callback: exchange code for token, upsert workspace ─────────────────────

slackOAuthApp.get("/oauth-callback", async (c) => {
  const code = c.req.query("code");
  const error = c.req.query("error");

  if (error) {
    logger.warn("Slack OAuth denied by user", { error });
    return c.html(
      `<html><body><h1>Installation cancelled</h1><p>${escapeHtml(error)}</p></body></html>`,
    );
  }

  const stateParam = c.req.query("state");
  const stateCookie = getCookie(c, "slack_oauth_state");
  if (!stateParam || !stateCookie || stateParam !== stateCookie) {
    logger.warn("Slack OAuth state mismatch", { stateParam, stateCookie });
    return c.json({ error: "Invalid OAuth state — possible CSRF" }, 403);
  }

  if (!code) {
    return c.json({ error: "Missing code parameter" }, 400);
  }

  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    logger.error("SLACK_CLIENT_ID or SLACK_CLIENT_SECRET not configured");
    return c.json({ error: "OAuth not configured" }, 500);
  }

  const redirectUri = getRedirectUri();

  try {
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const data = (await response.json()) as {
      ok: boolean;
      error?: string;
      team?: { id: string; name: string };
      bot_user_id?: string;
      access_token?: string;
      scope?: string;
      authed_user?: { id: string };
    };

    if (!data.ok) {
      logger.error("Slack OAuth token exchange failed", { error: data.error });
      return c.html(
        `<html><body><h1>Installation failed</h1><p>Slack returned: ${escapeHtml(data.error ?? "unknown error")}</p></body></html>`,
      );
    }

    const teamId = data.team?.id;
    const teamName = data.team?.name;
    const botToken = data.access_token;
    const botUserId = data.bot_user_id;
    const scopes = data.scope;
    const installerUserId = data.authed_user?.id;

    if (!teamId || !botToken) {
      logger.error("Slack OAuth response missing team or token", {
        team: data.team,
        bot_user_id: data.bot_user_id,
        scope: data.scope,
        error: data.error,
      });
      return c.json({ error: "Invalid OAuth response from Slack" }, 500);
    }

    await db
      .insert(workspaces)
      .values({
        id: teamId,
        name: teamName,
        botToken,
        botUserId,
        installerUserId,
        scopes,
        isActive: true,
        installedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: workspaces.id,
        set: {
          name: teamName,
          botToken,
          botUserId,
          installerUserId,
          scopes,
          isActive: true,
        },
      });

    logger.info("Slack workspace installed via OAuth", {
      teamId,
      teamName,
      botUserId,
      installerUserId,
    });

    return c.html(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Aura Installed!</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f8f9fa; }
    .card { background: white; border-radius: 12px; padding: 48px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 480px; }
    h1 { color: #1a1a2e; margin: 0 0 16px; }
    p { color: #666; line-height: 1.6; }
    .team { font-weight: 600; color: #4a154b; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Aura has been installed!</h1>
    <p>Successfully added to <span class="team">${escapeHtml(teamName || teamId)}</span>.</p>
    <p>You can now use Aura in your Slack workspace. Try sending a message in a DM or mentioning @Aura in a channel.</p>
  </div>
</body>
</html>`);
  } catch (err) {
    logger.error("Slack OAuth callback error", { error: String(err) });
    return c.html(
      `<html><body><h1>Installation failed</h1><p>An unexpected error occurred. Please try again.</p></body></html>`,
    );
  }
});

import crypto from "node:crypto";
import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SendEmailOptions {
  cc?: string;
  bcc?: string;
  replyToMessageId?: string;
  threadId?: string;
}

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  isUnread: boolean;
}

export interface EmailDetail {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  body: string;
  snippet: string;
  isUnread: boolean;
  attachments: { filename: string; mimeType: string; size: number }[];
}

export interface ListEmailsOptions {
  query?: string;
  maxResults?: number;
  unreadOnly?: boolean;
}

// ── OAuth2 Client ───────────────────────────────────────────────────────────

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/directory.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

// ── Email Signature ─────────────────────────────────────────────────────────

const EMAIL_SIGNATURE_HTML = `
<div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e0e0e0; font-family: Arial, sans-serif; font-size: 13px; color: #666;">
  <strong style="color: #333;">Aura</strong> &middot; AI Team Member<br/>
  <a href="https://www.realadvisor.com" style="color: #0066cc; text-decoration: none;">RealAdvisor</a>
</div>`.trim();

const EMAIL_SIGNATURE_TEXT = `\n--\nAura · AI Team Member\nRealAdvisor · https://www.realadvisor.com`;

function textToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br/>");
}

function getRedirectUri(): string {
  const host =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    "localhost:3000";
  const protocol = host.includes("localhost") ? "http" : "https";
  return `${protocol}://${host}/api/oauth/google/callback`;
}

const SETTINGS_KEY = "google_refresh_token";

export async function getRefreshToken(): Promise<string | null> {
  // DB is source of truth; env var is fallback for migration
  try {
    const { getSetting } = await import("./settings.js");
    const dbToken = await getSetting(SETTINGS_KEY);
    if (dbToken) return dbToken;
  } catch {
    // DB unavailable — fall back to env
  }
  return process.env.GOOGLE_EMAIL_REFRESH_TOKEN || null;
}

/**
 * Save a refresh token to the database.
 * Called by the OAuth callback after exchanging an auth code.
 */
export async function saveRefreshToken(token: string): Promise<void> {
  const { setSetting } = await import("./settings.js");
  await setSetting(SETTINGS_KEY, token, "oauth-callback");
  logger.info("Refresh token saved to database");
}

export async function getOAuth2Client() {
  const clientId = process.env.GOOGLE_EMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_EMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  const refreshToken = await getRefreshToken();

  const { OAuth2Client } = await import("google-auth-library");
  const oauth2Client = new OAuth2Client(
    clientId,
    clientSecret,
    getRedirectUri(),
  );

  if (refreshToken) {
    oauth2Client.setCredentials({ refresh_token: refreshToken });
  }

  return oauth2Client;
}

/**
 * Returns an authenticated Gmail client, or null if credentials are missing.
 */
export async function getGmailClient() {
  const auth = await getOAuth2Client();
  if (!auth) return null;

  // Verify we have a refresh token (check DB + env)
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    logger.warn("Gmail: No refresh token configured (checked DB and env)");
    return null;
  }

  const { gmail } = await import("@googleapis/gmail");
  return gmail({ version: "v1", auth });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildMimeMessage(
  to: string,
  subject: string,
  body: string,
  options?: SendEmailOptions,
): string {
  const auraEmail =
    process.env.AURA_EMAIL_ADDRESS || "aura@realadvisor.com";
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const htmlBody = `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6;">${textToHtml(body)}</div>\n${EMAIL_SIGNATURE_HTML}`;
  const textBody = `${body}${EMAIL_SIGNATURE_TEXT}`;

  const headers: string[] = [
    `From: Aura <${auraEmail}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  if (options?.cc) headers.push(`Cc: ${options.cc}`);
  if (options?.bcc) headers.push(`Bcc: ${options.bcc}`);
  if (options?.replyToMessageId) {
    headers.push(`In-Reply-To: ${options.replyToMessageId}`);
    headers.push(`References: ${options.replyToMessageId}`);
  }

  const parts = [
    headers.join("\r\n"),
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    textBody,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "",
    htmlBody,
    "",
    `--${boundary}--`,
  ];

  return parts.join("\r\n");
}

function getHeader(
  headers: { name?: string | null; value?: string | null }[],
  name: string,
): string {
  const header = headers.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return header?.value || "";
}

function extractBody(payload: any): string {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  if (payload.parts) {
    const textPart = payload.parts.find(
      (p: any) => p.mimeType === "text/plain",
    );
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, "base64").toString("utf-8");
    }

    const htmlPart = payload.parts.find(
      (p: any) => p.mimeType === "text/html",
    );
    if (htmlPart?.body?.data) {
      return Buffer.from(htmlPart.body.data, "base64").toString("utf-8");
    }

    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return "";
}

function extractAttachments(
  payload: any,
): { filename: string; mimeType: string; size: number }[] {
  const attachments: { filename: string; mimeType: string; size: number }[] =
    [];

  function walk(parts: any[]) {
    for (const part of parts) {
      if (part.filename && part.filename.length > 0) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType || "application/octet-stream",
          size: part.body?.size || 0,
        });
      }
      if (part.parts) walk(part.parts);
    }
  }

  if (payload.parts) walk(payload.parts);
  return attachments;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Send an email.
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  options?: SendEmailOptions,
): Promise<{ id: string; threadId: string } | null> {
  const gmail = await getGmailClient();
  if (!gmail) {
    logger.error("Gmail client not available");
    return null;
  }

  const raw = base64UrlEncode(buildMimeMessage(to, subject, body, options));

  const requestBody: { raw: string; threadId?: string } = { raw };
  if (options?.threadId) {
    requestBody.threadId = options.threadId;
  }

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody,
  });

  logger.info("Email sent", {
    to,
    subject,
    messageId: res.data.id,
    threadId: res.data.threadId,
  });

  return {
    id: res.data.id || "",
    threadId: res.data.threadId || "",
  };
}

async function listEmailsWithClient(
  gmailClient: any,
  options?: ListEmailsOptions,
): Promise<EmailSummary[]> {
  let q = options?.query || "";
  if (options?.unreadOnly) {
    q = q ? `${q} is:unread` : "is:unread";
  }

  const listRes = await gmailClient.users.messages.list({
    userId: "me",
    maxResults: Math.min(options?.maxResults || 10, 20),
    q: q || undefined,
  });

  const messages = listRes.data.messages || [];
  if (messages.length === 0) return [];

  const results: EmailSummary[] = await Promise.all(
    messages.map(async (msg: any) => {
      const detail = await gmailClient.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });

      const headers = detail.data.payload?.headers || [];
      return {
        id: detail.data.id || "",
        threadId: detail.data.threadId || "",
        from: getHeader(headers, "From"),
        to: getHeader(headers, "To"),
        subject: getHeader(headers, "Subject"),
        date: getHeader(headers, "Date"),
        snippet: detail.data.snippet || "",
        isUnread: (detail.data.labelIds || []).includes("UNREAD"),
      };
    }),
  );

  return results;
}

/**
 * List emails from the inbox.
 */
export async function listEmails(
  options?: ListEmailsOptions,
): Promise<EmailSummary[]> {
  const gmail = await getGmailClient();
  if (!gmail) {
    logger.error("Gmail client not available");
    return [];
  }

  return listEmailsWithClient(gmail, options);
}

async function getEmailWithClient(
  gmailClient: any,
  messageId: string,
): Promise<EmailDetail> {
  const res = await gmailClient.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = res.data.payload?.headers || [];
  const payload = res.data.payload || {};
  const body = extractBody(payload);
  const attachments = extractAttachments(payload);

  return {
    id: res.data.id || "",
    threadId: res.data.threadId || "",
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    body,
    snippet: res.data.snippet || "",
    isUnread: (res.data.labelIds || []).includes("UNREAD"),
    attachments,
  };
}

/**
 * Get full details of a specific email.
 */
export async function getEmail(messageId: string): Promise<EmailDetail | null> {
  const gmail = await getGmailClient();
  if (!gmail) {
    logger.error("Gmail client not available");
    return null;
  }

  return getEmailWithClient(gmail, messageId);
}

/**
 * Reply to an email in the same thread.
 */
export async function replyToEmail(
  messageId: string,
  threadId: string,
  body: string,
): Promise<{ id: string; threadId: string } | null> {
  const gmail = await getGmailClient();
  if (!gmail) {
    logger.error("Gmail client not available");
    return null;
  }

  // Get original message to extract headers
  const original = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["From", "Subject", "Message-ID"],
  });

  const headers = original.data.payload?.headers || [];
  const originalFrom = getHeader(headers, "From");
  const originalSubject = getHeader(headers, "Subject");
  const originalMessageId = getHeader(headers, "Message-ID");

  const replySubject = originalSubject.startsWith("Re:")
    ? originalSubject
    : `Re: ${originalSubject}`;

  const raw = base64UrlEncode(
    buildMimeMessage(originalFrom, replySubject, body, {
      replyToMessageId: originalMessageId,
      threadId,
    }),
  );

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      threadId,
    },
  });

  logger.info("Email reply sent", {
    to: originalFrom,
    subject: replySubject,
    messageId: res.data.id,
    threadId: res.data.threadId,
  });

  return {
    id: res.data.id || "",
    threadId: res.data.threadId || "",
  };
}

function getOAuthStateSecret(): string {
  return process.env.SLACK_SIGNING_SECRET || process.env.GOOGLE_EMAIL_CLIENT_SECRET || "";
}

function signOAuthState(userId: string): string {
  const secret = getOAuthStateSecret();
  const sig = crypto.createHmac("sha256", secret).update(userId).digest("hex");
  return JSON.stringify({ userId, sig });
}

/**
 * Verify the HMAC signature on an OAuth state parameter.
 * Returns the userId if valid, or null if tampered/missing.
 */
export function verifyOAuthState(stateParam: string): string | null {
  try {
    const { userId, sig } = JSON.parse(stateParam);
    if (!userId || !sig) return null;
    const secret = getOAuthStateSecret();
    if (!secret) return null;
    const expected = crypto.createHmac("sha256", secret).update(userId).digest("hex");
    const valid = crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
    return valid ? userId : null;
  } catch {
    return null;
  }
}

/**
 * Generate an OAuth consent URL for Gmail access.
 * If stateData.userId is provided, it's embedded in the OAuth state param
 * so the callback can associate the token with that Slack user.
 * Returns null if client ID/secret are not configured.
 */
export function generateAuthUrl(stateData?: { userId?: string }): string | null {
  const clientId = process.env.GOOGLE_EMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_EMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  const redirectUri = getRedirectUri();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  });

  if (stateData?.userId) {
    params.set("state", signOAuthState(stateData.userId));
  }

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 * Returns the refresh token and granted scopes, or null on failure.
 */
export async function exchangeCodeForTokens(
  code: string,
): Promise<{ refreshToken: string | null; scopes?: string; error?: string }> {
  const auth = await getOAuth2Client();
  if (!auth) return { refreshToken: null, error: "OAuth client not configured" };

  try {
    const { tokens } = await auth.getToken(code);
    logger.info("OAuth tokens obtained", {
      hasRefreshToken: !!tokens.refresh_token,
      hasAccessToken: !!tokens.access_token,
      scope: tokens.scope,
    });
    return {
      refreshToken: tokens.refresh_token || null,
      scopes: tokens.scope || undefined,
    };
  } catch (error: any) {
    const msg = error.message || "Unknown error";
    logger.error("Failed to exchange OAuth code for tokens", {
      error: msg,
      response: error.response?.data,
    });
    return { refreshToken: null, error: msg };
  }
}

// ── Multi-user OAuth token storage ─────────────────────────────────────────

/**
 * Save a refresh token for a specific Slack user to the oauth_tokens table.
 */
export async function saveUserRefreshToken(
  userId: string,
  refreshToken: string,
  scopes?: string,
): Promise<void> {
  const { db } = await import("../db/client.js");
  const { oauthTokens } = await import("../db/schema.js");

  await db
    .insert(oauthTokens)
    .values({
      userId,
      provider: "google",
      refreshToken,
      scopes: scopes || SCOPES.join(" "),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [oauthTokens.userId, oauthTokens.provider],
      set: {
        refreshToken,
        scopes: scopes || SCOPES.join(" "),
        updatedAt: new Date(),
      },
    });

  logger.info("User refresh token saved", { userId });
}

/**
 * Get a user's refresh token from the oauth_tokens table.
 */
async function getUserRefreshToken(userId: string): Promise<string | null> {
  try {
    const { db } = await import("../db/client.js");
    const { oauthTokens } = await import("../db/schema.js");
    const { eq, and } = await import("drizzle-orm");

    const rows = await db
      .select({ refreshToken: oauthTokens.refreshToken })
      .from(oauthTokens)
      .where(
        and(eq(oauthTokens.userId, userId), eq(oauthTokens.provider, "google")),
      )
      .limit(1);

    return rows[0]?.refreshToken ?? null;
  } catch (error) {
    logger.error("Failed to get user refresh token", { userId, error });
    return null;
  }
}

/**
 * Returns an authenticated Gmail client for a specific Slack user.
 * Looks up the user's refresh token from oauth_tokens.
 * Returns null if no token found or credentials are missing.
 */
export async function getGmailClientForUser(userId: string) {
  const clientId = process.env.GOOGLE_EMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_EMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const refreshToken = await getUserRefreshToken(userId);
  if (!refreshToken) {
    logger.warn("No OAuth token found for user", { userId });
    return null;
  }

  const { OAuth2Client } = await import("google-auth-library");
  const oauth2Client = new OAuth2Client(clientId, clientSecret, getRedirectUri());
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const { gmail } = await import("@googleapis/gmail");
  return gmail({ version: "v1", auth: oauth2Client });
}

// ── Draft creation & management ────────────────────────────────────────────

export interface DraftOptions {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  quotedMessage?: string;
}

export interface DraftSummary {
  draftId: string;
  messageId: string;
  threadId: string;
  subject: string;
  to: string;
  snippet: string;
}

function buildDraftMimeMessage(
  to: string,
  subject: string,
  body: string,
  options?: {
    cc?: string;
    bcc?: string;
    inReplyTo?: string;
    references?: string;
    quotedMessage?: string;
  },
): string {
  const headers: string[] = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ];

  if (options?.cc) headers.push(`Cc: ${options.cc}`);
  if (options?.bcc) headers.push(`Bcc: ${options.bcc}`);
  if (options?.inReplyTo) {
    headers.push(`In-Reply-To: ${options.inReplyTo}`);
    headers.push(`References: ${options.references || options.inReplyTo}`);
  }

  let fullBody = body;
  if (options?.quotedMessage) {
    const quotedLines = options.quotedMessage
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    fullBody += `\n\n${quotedLines}`;
  }

  return headers.join("\r\n") + "\r\n\r\n" + fullBody;
}

/**
 * Create a draft in a user's Gmail.
 */
export async function createDraft(
  userId: string,
  options: DraftOptions,
): Promise<{ draftId: string; messageId: string } | null> {
  const gmail = await getGmailClientForUser(userId);
  if (!gmail) {
    logger.error("Gmail client not available for user", { userId });
    return null;
  }

  const raw = base64UrlEncode(
    buildDraftMimeMessage(options.to, options.subject, options.body, {
      cc: options.cc,
      bcc: options.bcc,
      inReplyTo: options.inReplyTo,
      references: options.references,
      quotedMessage: options.quotedMessage,
    }),
  );

  const requestBody: { message: { raw: string; threadId?: string } } = {
    message: { raw },
  };
  if (options.threadId) {
    requestBody.message.threadId = options.threadId;
  }

  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody,
  });

  logger.info("Draft created", {
    userId,
    to: options.to,
    subject: options.subject,
    draftId: res.data.id,
  });

  return {
    draftId: res.data.id || "",
    messageId: res.data.message?.id || "",
  };
}

/**
 * List drafts in a user's Gmail.
 */
export async function listDrafts(userId: string): Promise<DraftSummary[]> {
  const gmail = await getGmailClientForUser(userId);
  if (!gmail) {
    logger.error("Gmail client not available for user", { userId });
    return [];
  }

  const listRes = await gmail.users.drafts.list({
    userId: "me",
    maxResults: 20,
  });

  const drafts = listRes.data.drafts || [];
  if (drafts.length === 0) return [];

  const results: DraftSummary[] = await Promise.all(
    drafts.map(async (draft) => {
      const detail = await gmail.users.drafts.get({
        userId: "me",
        id: draft.id!,
        format: "metadata",
      });

      const headers = detail.data.message?.payload?.headers || [];
      return {
        draftId: detail.data.id || "",
        messageId: detail.data.message?.id || "",
        threadId: detail.data.message?.threadId || "",
        subject: getHeader(headers, "Subject"),
        to: getHeader(headers, "To"),
        snippet: detail.data.message?.snippet || "",
      };
    }),
  );

  return results;
}

/**
 * Read emails from a specific user's inbox (not Aura's).
 */
export async function readUserEmails(
  userId: string,
  options?: ListEmailsOptions,
): Promise<EmailSummary[]> {
  const gmail = await getGmailClientForUser(userId);
  if (!gmail) {
    logger.error("Gmail client not available for user", { userId });
    return [];
  }

  return listEmailsWithClient(gmail, options);
}

/**
 * Read a specific email from a user's inbox.
 */
export async function readUserEmail(
  userId: string,
  messageId: string,
): Promise<EmailDetail | null> {
  const gmail = await getGmailClientForUser(userId);
  if (!gmail) {
    logger.error("Gmail client not available for user", { userId });
    return null;
  }

  return getEmailWithClient(gmail, messageId);
}

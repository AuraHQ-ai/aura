import crypto from "node:crypto";
import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface Attachment {
  filename: string;
  mimeType: string;
  /** Base64-encoded file content */
  content: string;
}

export interface SendEmailOptions {
  cc?: string;
  bcc?: string;
  replyToMessageId?: string;
  threadId?: string;
  attachments?: Attachment[];
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
  attachments: { filename: string; mimeType: string; size: number; attachmentId: string }[];
}

export interface ListEmailsOptions {
  query?: string;
  maxResults?: number;
  unreadOnly?: boolean;
  pageToken?: string;
}

export interface ListEmailsResult {
  emails: EmailSummary[];
  nextPageToken?: string | null;
}

// ── OAuth2 Client ───────────────────────────────────────────────────────────

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/directory.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
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

/**
 * RFC 2047 encode a subject line if it contains non-ASCII characters.
 * MIME headers must be ASCII-only; non-ASCII needs encoded-word syntax.
 */
function encodeSubject(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;

  // RFC 2047 limits each encoded-word to 75 chars.
  // "=?UTF-8?B?" (10) + "?=" (2) = 12 chars overhead, leaving 63 for base64.
  // 63 base64 chars encode floor(63/4)*3 = 45 bytes of UTF-8 per chunk.
  const MAX_BYTES_PER_CHUNK = 45;
  const buf = Buffer.from(subject, "utf-8");
  const words: string[] = [];

  for (let offset = 0; offset < buf.length; ) {
    let end = Math.min(offset + MAX_BYTES_PER_CHUNK, buf.length);
    // Avoid splitting in the middle of a multi-byte UTF-8 sequence:
    // continuation bytes have the form 10xxxxxx (0x80–0xBF).
    while (end > offset && end < buf.length && (buf[end]! & 0xc0) === 0x80) {
      end--;
    }
    words.push(`=?UTF-8?B?${buf.subarray(offset, end).toString("base64")}?=`);
    offset = end;
  }

  return words.join("\r\n ");
}

/**
 * Split a base64 string into 76-character lines per RFC 2045.
 */
function splitBase64Lines(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

function buildMimeMessage(
  to: string,
  subject: string,
  body: string,
  options?: SendEmailOptions,
  explicitInReplyTo?: string,
  explicitReferences?: string,
  overrides?: { from?: string; includeSignature?: boolean },
  attachments?: Attachment[],
): string {
  const auraEmail =
    process.env.AURA_EMAIL_ADDRESS || "aura@realadvisor.com";
  const fromHeader = overrides?.from || `Aura <${auraEmail}>`;
  const includeSignature = overrides?.includeSignature !== false;
  const altBoundary = `boundary_alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const htmlBody = includeSignature
    ? `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6;">${textToHtml(body)}</div>\n${EMAIL_SIGNATURE_HTML}`
    : `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; line-height: 1.6;">${textToHtml(body)}</div>`;
  const textBody = includeSignature ? `${body}${EMAIL_SIGNATURE_TEXT}` : body;

  const hasAttachments = attachments && attachments.length > 0;
  const mixedBoundary = hasAttachments
    ? `boundary_mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`
    : null;

  const headers: string[] = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
  ];

  if (hasAttachments) {
    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  } else {
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  }

  if (options?.cc) headers.push(`Cc: ${options.cc}`);
  if (options?.bcc) headers.push(`Bcc: ${options.bcc}`);
  const inReplyToValue = explicitInReplyTo || options?.replyToMessageId;
  const referencesValue = explicitReferences || options?.replyToMessageId;
  if (inReplyToValue) {
    headers.push(`In-Reply-To: ${inReplyToValue}`);
  }
  if (referencesValue) {
    headers.push(`References: ${referencesValue}`);
  }

  if (hasAttachments) {
    const parts = [
      headers.join("\r\n"),
      "",
      `--${mixedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      textBody,
      "",
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "",
      htmlBody,
      "",
      `--${altBoundary}--`,
    ];

    for (const att of attachments!) {
      parts.push(
        "",
        `--${mixedBoundary}`,
        `Content-Type: ${att.mimeType}; name="${att.filename}"`,
        `Content-Disposition: attachment; filename="${att.filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        splitBase64Lines(att.content),
      );
    }

    parts.push("", `--${mixedBoundary}--`);
    return parts.join("\r\n");
  }

  const parts = [
    headers.join("\r\n"),
    "",
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    textBody,
    "",
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "",
    htmlBody,
    "",
    `--${altBoundary}--`,
  ];

  return parts.join("\r\n");
}

export function getHeader(
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

/**
 * Extract both HTML and plain-text body from a Gmail message payload.
 * Recurses into multipart/* containers.
 */
export function extractBodyParts(payload: any): {
  html: string;
  plain: string;
} {
  let html = "";
  let plain = "";

  function walk(part: any): void {
    const mime: string = part.mimeType || "";

    if (mime === "text/html" && part.body?.data) {
      html = html || Buffer.from(part.body.data, "base64").toString("utf-8");
    } else if (mime === "text/plain" && part.body?.data) {
      plain = plain || Buffer.from(part.body.data, "base64").toString("utf-8");
    } else if (mime.startsWith("multipart/") && part.parts) {
      for (const child of part.parts) walk(child);
    }
  }

  walk(payload);
  return { html, plain };
}

/**
 * Returns true if the message payload contains any attachment parts
 * (i.e. parts with a non-empty filename).
 */
export function hasAttachmentParts(payload: any): boolean {
  function walk(part: any): boolean {
    if (part.filename && part.filename.length > 0) return true;
    if (part.parts) {
      for (const child of part.parts) {
        if (walk(child)) return true;
      }
    }
    return false;
  }
  return walk(payload);
}

function extractAttachments(
  payload: any,
): { filename: string; mimeType: string; size: number; attachmentId: string }[] {
  const attachments: { filename: string; mimeType: string; size: number; attachmentId: string }[] =
    [];

  function walk(parts: any[]) {
    for (const part of parts) {
      if (part.filename && part.filename.length > 0) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType || "application/octet-stream",
          size: part.body?.size || 0,
          attachmentId: part.body?.attachmentId || "",
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

  const raw = base64UrlEncode(
    buildMimeMessage(to, subject, body, options, undefined, undefined, undefined, options?.attachments),
  );

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

// ── Shared helpers (DRY: used by both Aura and user-facing functions) ───────

async function listEmailsWithClient(
  gmailClient: any,
  options?: ListEmailsOptions,
): Promise<ListEmailsResult> {
  let q = options?.query || "";
  if (options?.unreadOnly) {
    q = q ? `${q} is:unread` : "is:unread";
  }

  const listRes = await gmailClient.users.messages.list({
    userId: "me",
    maxResults: Math.min(options?.maxResults || 10, 20),
    q: q || undefined,
    pageToken: options?.pageToken || undefined,
  });

  const nextPageToken: string | null = listRes.data.nextPageToken || null;
  const messages = listRes.data.messages || [];
  if (messages.length === 0) return { emails: [], nextPageToken };

  const emails: EmailSummary[] = await Promise.all(
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

  return { emails, nextPageToken };
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
 * List emails from the inbox.
 */
export async function listEmails(
  options?: ListEmailsOptions,
): Promise<ListEmailsResult> {
  const gmail = await getGmailClient();
  if (!gmail) {
    logger.error("Gmail client not available");
    return { emails: [], nextPageToken: null };
  }

  return listEmailsWithClient(gmail, options);
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

/**
 * Generate an OAuth consent URL for Gmail access.
 * Returns null if client ID/secret are not configured.
 */
export function generateAuthUrl(): string | null {
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

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 * Returns the refresh token, or null on failure.
 */
export async function exchangeCodeForTokens(
  code: string,
): Promise<{ refreshToken: string | null; email?: string; error?: string }> {
  const auth = await getOAuth2Client();
  if (!auth) return { refreshToken: null, error: "OAuth client not configured" };

  try {
    const { tokens } = await auth.getToken(code);
    logger.info("OAuth tokens obtained", {
      hasRefreshToken: !!tokens.refresh_token,
      hasAccessToken: !!tokens.access_token,
    });

    let email: string | undefined;
    if (tokens.access_token) {
      try {
        const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (res.ok) {
          const profile = (await res.json()) as { emailAddress?: string };
          email = profile.emailAddress || undefined;
        }
      } catch (e) {
        logger.warn("Failed to fetch user email from userinfo endpoint", { error: e });
      }
    }

    return { refreshToken: tokens.refresh_token || null, email };
  } catch (error: any) {
    const msg = error.message || "Unknown error";
    logger.error("Failed to exchange OAuth code for tokens", {
      error: msg,
      response: error.response?.data,
    });
    return { refreshToken: null, error: msg };
  }
}

// ── Multi-user OAuth ────────────────────────────────────────────────────────

export interface CreateDraftOptions {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  quotedMessage?: string;
  attachments?: Attachment[];
}

export interface DraftSummary {
  draftId: string;
  messageId: string;
  subject: string;
  to: string;
  snippet: string;
}

/**
 * Get a refresh token for a specific Slack user from the oauth_tokens table.
 * Returns null if the user has not authorized Aura.
 */
export async function getUserRefreshToken(
  userId: string,
): Promise<{ refreshToken: string; email: string | null } | null> {
  try {
    const { eq, and } = await import("drizzle-orm");
    const { db } = await import("../db/client.js");
    const { oauthTokens } = await import("../db/schema.js");

    const rows = await db
      .select({
        refreshToken: oauthTokens.refreshToken,
        email: oauthTokens.email,
      })
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.userId, userId),
          eq(oauthTokens.provider, "google"),
        ),
      )
      .limit(1);

    if (!rows[0]) return null;
    return {
      refreshToken: rows[0].refreshToken,
      email: rows[0].email,
    };
  } catch (error) {
    logger.error("Failed to get user refresh token", { userId, error });
    return null;
  }
}

/**
 * Save or update a user's OAuth refresh token.
 */
export async function saveUserRefreshToken(
  userId: string,
  refreshToken: string,
  email?: string,
): Promise<void> {
  const { db } = await import("../db/client.js");
  const { oauthTokens } = await import("../db/schema.js");

  await db
    .insert(oauthTokens)
    .values({
      userId,
      provider: "google",
      refreshToken,
      email: email || null,
      scopes: SCOPES.join(" "),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [oauthTokens.userId, oauthTokens.provider],
      set: {
        refreshToken,
        email: email || undefined,
        scopes: SCOPES.join(" "),
        updatedAt: new Date(),
      },
    });

  logger.info("User OAuth refresh token saved", { userId, email });
}

/**
 * Get an authenticated Gmail client for a specific Slack user.
 * Returns null if the user has not authorized or credentials are missing.
 */
export async function getGmailClientForUser(userId: string) {
  const clientId = process.env.GOOGLE_EMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_EMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    logger.warn("Gmail: OAuth client credentials not configured");
    return null;
  }

  const userToken = await getUserRefreshToken(userId);
  if (!userToken) {
    logger.warn("Gmail: No OAuth token found for user", { userId });
    return null;
  }

  const { OAuth2Client } = await import("google-auth-library");
  const oauth2Client = new OAuth2Client(
    clientId,
    clientSecret,
    getRedirectUri(),
  );
  oauth2Client.setCredentials({ refresh_token: userToken.refreshToken });

  const { gmail } = await import("@googleapis/gmail");
  const client = gmail({ version: "v1", auth: oauth2Client });
  return { client, email: userToken.email, oauth2Client };
}

// ── OAuth State Signing (nonce + TTL) ───────────────────────────────────────

function getOAuthStateSecret(): string {
  return process.env.GOOGLE_EMAIL_CLIENT_SECRET || "";
}

const OAUTH_STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

function signOAuthState(userId: string): string {
  const secret = getOAuthStateSecret();
  const nonce = crypto.randomBytes(16).toString("hex");
  const ts = Date.now();
  const payload = `${userId}:${nonce}:${ts}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return JSON.stringify({ userId, nonce, ts, sig });
}

/**
 * Verify the HMAC signature on an OAuth state parameter.
 * Returns the userId if valid, or null if tampered/expired/missing.
 */
export function verifyOAuthState(stateParam: string): string | null {
  try {
    const { userId, nonce, ts, sig } = JSON.parse(stateParam);
    if (!userId || !nonce || !ts || !sig) return null;
    const secret = getOAuthStateSecret();
    if (!secret) return null;
    if (Date.now() - ts > OAUTH_STATE_EXPIRY_MS) return null;
    const payload = `${userId}:${nonce}:${ts}`;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const valid = crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
    return valid ? userId : null;
  } catch {
    return null;
  }
}

/**
 * Generate an OAuth consent URL for a specific user.
 * Encodes the user_id in a signed state parameter so the callback can save the token.
 */
export function generateAuthUrlForUser(userId: string): string | null {
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
    state: signOAuthState(userId),
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// ── Draft Functions ─────────────────────────────────────────────────────────

/**
 * Create a draft email in a user's Gmail account.
 */
export async function createDraft(
  userId: string,
  options: CreateDraftOptions,
): Promise<{ draftId: string; messageId: string } | null> {
  const result = await getGmailClientForUser(userId);
  if (!result) return null;

  const { client: gmail, email: userEmail } = result;

  let bodyText = options.body;
  if (options.quotedMessage) {
    bodyText += `\n\n---------- Forwarded message ----------\n${options.quotedMessage}`;
  }

  const raw = base64UrlEncode(
    buildMimeMessage(
      options.to,
      options.subject,
      bodyText,
      {
        cc: options.cc,
        bcc: options.bcc,
        replyToMessageId: options.inReplyTo,
        threadId: options.threadId,
      },
      options.inReplyTo,
      options.references,
      {
        from: userEmail || undefined,
        includeSignature: false,
      },
      options.attachments,
    ),
  );

  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        raw,
        threadId: options.threadId || undefined,
      },
    },
  });

  logger.info("Draft created", {
    userId,
    draftId: res.data.id,
    to: options.to,
    subject: options.subject,
  });

  return {
    draftId: res.data.id || "",
    messageId: res.data.message?.id || "",
  };
}

/**
 * List drafts in a user's Gmail account.
 */
export async function listDrafts(
  userId: string,
  maxResults: number = 10,
): Promise<DraftSummary[] | null> {
  const result = await getGmailClientForUser(userId);
  if (!result) return null;

  const { client: gmail } = result;
  const res = await gmail.users.drafts.list({
    userId: "me",
    maxResults,
  });

  const drafts = res.data.drafts || [];
  if (drafts.length === 0) return [];

  const results: DraftSummary[] = await Promise.all(
    drafts.filter((draft) => draft.id).map(async (draft) => {
      try {
        const detail = await gmail.users.drafts.get({
          userId: "me",
          id: draft.id!,
          format: "metadata",
        });
        const headers = detail.data.message?.payload?.headers || [];
        return {
          draftId: draft.id!,
          messageId: detail.data.message?.id || "",
          subject: getHeader(headers as any[], "Subject") || "(no subject)",
          to: getHeader(headers as any[], "To"),
          snippet: detail.data.message?.snippet || "",
        };
      } catch {
        return {
          draftId: draft.id!,
          messageId: draft.message?.id || "",
          subject: "(unable to read)",
          to: "",
          snippet: "",
        };
      }
    }),
  );

  return results;
}

/**
 * Delete a draft from a user's Gmail account.
 */
export async function deleteDraft(
  userId: string,
  draftId: string,
): Promise<boolean> {
  const result = await getGmailClientForUser(userId);
  if (!result) return false;

  const { client: gmail } = result;
  await gmail.users.drafts.delete({
    userId: "me",
    id: draftId,
  });

  logger.info("Draft deleted", { userId, draftId });
  return true;
}

/**
 * Download an attachment from a Gmail message.
 * Returns standard base64-encoded data and size.
 */
async function getAttachmentWithClient(
  gmailClient: any,
  messageId: string,
  attachmentId: string,
): Promise<{ data: string; size: number }> {
  const res = await gmailClient.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });

  let data: string = res.data.data || "";
  // Gmail API returns URL-safe base64; convert to standard base64
  data = data.replace(/-/g, "+").replace(/_/g, "/");
  // Restore padding stripped by base64url encoding
  const pad = (4 - (data.length % 4)) % 4;
  if (pad) data += "=".repeat(pad);

  return {
    data,
    size: res.data.size || 0,
  };
}

/**
 * Download an attachment from a specific user's Gmail message.
 * Returns standard base64-encoded data and size, or null if access is unavailable.
 */
export async function getUserEmailAttachment(
  userId: string,
  messageId: string,
  attachmentId: string,
): Promise<{ data: string; size: number } | null> {
  const result = await getGmailClientForUser(userId);
  if (!result) return null;

  return getAttachmentWithClient(result.client, messageId, attachmentId);
}

/**
 * Read emails from a specific user's Gmail inbox.
 */
export async function readUserEmails(
  userId: string,
  options?: ListEmailsOptions,
): Promise<ListEmailsResult | null> {
  const result = await getGmailClientForUser(userId);
  if (!result) return null;

  return listEmailsWithClient(result.client, options);
}

/**
 * Read a specific email from a user's Gmail inbox.
 */
export async function readUserEmail(
  userId: string,
  messageId: string,
): Promise<EmailDetail | null> {
  const result = await getGmailClientForUser(userId);
  if (!result) return null;

  return getEmailWithClient(result.client, messageId);
}

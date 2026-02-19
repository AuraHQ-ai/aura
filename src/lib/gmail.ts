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

async function getOAuth2Client() {
  const clientId = process.env.GOOGLE_EMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_EMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_EMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret) {
    return null;
  }

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

  // Verify we have a refresh token
  if (!process.env.GOOGLE_EMAIL_REFRESH_TOKEN) {
    logger.warn("Gmail: No refresh token configured");
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

  let q = options?.query || "";
  if (options?.unreadOnly) {
    q = q ? `${q} is:unread` : "is:unread";
  }

  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults: Math.min(options?.maxResults || 10, 20),
    q: q || undefined,
  });

  const messages = listRes.data.messages || [];
  if (messages.length === 0) return [];

  const results: EmailSummary[] = await Promise.all(
    messages.map(async (msg) => {
      const detail = await gmail.users.messages.get({
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
 * Get full details of a specific email.
 */
export async function getEmail(messageId: string): Promise<EmailDetail | null> {
  const gmail = await getGmailClient();
  if (!gmail) {
    logger.error("Gmail client not available");
    return null;
  }

  const res = await gmail.users.messages.get({
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
): Promise<{ refreshToken: string | null; error?: string }> {
  const auth = await getOAuth2Client();
  if (!auth) return { refreshToken: null, error: "OAuth client not configured" };

  try {
    const { tokens } = await auth.getToken(code);
    logger.info("OAuth tokens obtained", {
      hasRefreshToken: !!tokens.refresh_token,
      hasAccessToken: !!tokens.access_token,
    });
    return { refreshToken: tokens.refresh_token || null };
  } catch (error: any) {
    const msg = error.message || "Unknown error";
    logger.error("Failed to exchange OAuth code for tokens", {
      error: msg,
      response: error.response?.data,
    });
    return { refreshToken: null, error: msg };
  }
}

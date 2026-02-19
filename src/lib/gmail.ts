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

  const { google } = await import("googleapis");
  const oauth2Client = new google.auth.OAuth2(
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
  if (!auth) {
    logger.warn(
      "GOOGLE_EMAIL_CLIENT_ID or GOOGLE_EMAIL_CLIENT_SECRET not set — Gmail tools will be unavailable",
    );
    return null;
  }

  if (!process.env.GOOGLE_EMAIL_REFRESH_TOKEN) {
    logger.warn(
      "GOOGLE_EMAIL_REFRESH_TOKEN not set — Gmail tools will be unavailable",
    );
    return null;
  }

  const { google } = await import("googleapis");
  return google.gmail({ version: "v1", auth });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getHeader(
  headers: { name?: string | null; value?: string | null }[],
  name: string,
): string {
  const h = headers.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return h?.value || "";
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(str: string): string {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf-8");
}

function buildMimeMessage(
  to: string,
  subject: string,
  body: string,
  options?: SendEmailOptions & { from?: string },
): string {
  const fromAddr =
    options?.from ||
    process.env.AURA_EMAIL_ADDRESS ||
    "aura@realadvisor.com";
  const lines: string[] = [
    `From: ${fromAddr}`,
    `To: ${to}`,
  ];

  if (options?.cc) lines.push(`Cc: ${options.cc}`);
  if (options?.bcc) lines.push(`Bcc: ${options.bcc}`);
  if (options?.replyToMessageId) {
    lines.push(`In-Reply-To: ${options.replyToMessageId}`);
    lines.push(`References: ${options.replyToMessageId}`);
  }

  lines.push(`Subject: ${subject}`);
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("");
  lines.push(body);

  return lines.join("\r\n");
}

function extractBody(payload: any): string {
  if (payload.body?.data) {
    return base64UrlDecode(payload.body.data);
  }

  if (payload.parts) {
    // Prefer text/plain, fall back to text/html
    const textPart = payload.parts.find(
      (p: any) => p.mimeType === "text/plain",
    );
    if (textPart?.body?.data) {
      return base64UrlDecode(textPart.body.data);
    }

    const htmlPart = payload.parts.find(
      (p: any) => p.mimeType === "text/html",
    );
    if (htmlPart?.body?.data) {
      return base64UrlDecode(htmlPart.body.data);
    }

    // Recurse into nested multipart parts
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
      if (part.filename && part.body?.attachmentId) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType || "application/octet-stream",
          size: part.body.size || 0,
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
 * Send an email from the configured Gmail account.
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  options?: SendEmailOptions,
): Promise<{ id: string; threadId: string }> {
  const gmail = await getGmailClient();
  if (!gmail) throw new Error("Gmail is not configured");

  const raw = base64UrlEncode(
    buildMimeMessage(to, subject, body, options),
  );

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      threadId: options?.threadId || undefined,
    },
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
 * List emails from the inbox with optional filters.
 */
export async function listEmails(
  options?: ListEmailsOptions,
): Promise<EmailSummary[]> {
  const gmail = await getGmailClient();
  if (!gmail) throw new Error("Gmail is not configured");

  const queryParts: string[] = [];
  if (options?.query) queryParts.push(options.query);
  if (options?.unreadOnly) queryParts.push("is:unread");
  const q = queryParts.join(" ") || undefined;

  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults: Math.min(options?.maxResults || 10, 20),
    q,
  });

  const messageIds = listRes.data.messages || [];
  if (messageIds.length === 0) return [];

  const summaries: EmailSummary[] = await Promise.all(
    messageIds.map(async (msg) => {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });

      const headers = detail.data.payload?.headers || [];
      const labelIds = detail.data.labelIds || [];

      return {
        id: detail.data.id || "",
        threadId: detail.data.threadId || "",
        from: getHeader(headers, "From"),
        to: getHeader(headers, "To"),
        subject: getHeader(headers, "Subject"),
        date: getHeader(headers, "Date"),
        snippet: detail.data.snippet || "",
        isUnread: labelIds.includes("UNREAD"),
      };
    }),
  );

  return summaries;
}

/**
 * Get full email content by message ID.
 */
export async function getEmail(messageId: string): Promise<EmailDetail> {
  const gmail = await getGmailClient();
  if (!gmail) throw new Error("Gmail is not configured");

  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = res.data.payload?.headers || [];
  const labelIds = res.data.labelIds || [];
  const payload = res.data.payload || {};

  return {
    id: res.data.id || "",
    threadId: res.data.threadId || "",
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    body: extractBody(payload),
    snippet: res.data.snippet || "",
    isUnread: labelIds.includes("UNREAD"),
    attachments: extractAttachments(payload),
  };
}

/**
 * Reply to an existing email thread.
 * Fetches the original message to build proper threading headers.
 */
export async function replyToEmail(
  messageId: string,
  threadId: string,
  body: string,
): Promise<{ id: string; threadId: string }> {
  const gmail = await getGmailClient();
  if (!gmail) throw new Error("Gmail is not configured");

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
): Promise<string | null> {
  const auth = await getOAuth2Client();
  if (!auth) return null;

  try {
    const { tokens } = await auth.getToken(code);
    logger.info("OAuth tokens obtained", {
      hasRefreshToken: !!tokens.refresh_token,
      hasAccessToken: !!tokens.access_token,
    });
    return tokens.refresh_token || null;
  } catch (error: any) {
    logger.error("Failed to exchange OAuth code for tokens", {
      error: error.message,
    });
    return null;
  }
}

import TurndownService from "turndown";
import { db } from "../db/client.js";
import { emailsRaw, type NewEmailRaw } from "../db/schema.js";
import {
  getGmailClientForUser,
  getHeader,
  extractBodyParts,
  hasAttachmentParts,
} from "./gmail.js";
import { logger } from "./logger.js";
import { logError } from "./error-logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SyncOptions {
  /** Gmail search query, e.g. "newer_than:7d" */
  query?: string;
  /** Max number of messages to fetch per call (default 500) */
  maxMessages?: number;
}

export interface SyncError {
  gmailMessageId: string;
  reason: string;
}

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: number;
  errorDetails: SyncError[];
}

// ── HTML to Markdown ────────────────────────────────────────────────────────

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

turndown.remove(["style", "script", "head"]);

turndown.addRule("emailSignatures", {
  filter: (node) => {
    if ((node as any).childElementCount > 0) return false;
    const text = (node as any).textContent?.toLowerCase() || "";
    return (
      text.includes("sent from my iphone") ||
      text.includes("sent from my android") ||
      text.includes("get outlook for")
    );
  },
  replacement: () => "",
});

function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 200);
  return /font-family:|<div|<table|<style|\{\s*[a-z-]+\s*:/i.test(head);
}

function htmlToMarkdown(html: string, plain?: string): string {
  if (!html && !plain) return "";
  if (!html) return plain || "";
  try {
    const md = turndown
      .turndown(html)
      .replace(/\n\s*\n\s*\n/g, "\n\n")
      .trim();
    if (md && !looksLikeHtml(md)) return md;
    return plain || md || "";
  } catch {
    return plain || "";
  }
}

// ── Parse email address ─────────────────────────────────────────────────────

function parseEmailAddress(raw: string): { email: string; name: string } {
  const match = raw.match(/^(?:"?([^"<]*)"?\s*)?<?([^>]+@[^>]+)>?$/);
  if (match) {
    return {
      email: match[2].trim().toLowerCase(),
      name: (match[1] || "").trim(),
    };
  }
  return { email: raw.trim().toLowerCase(), name: "" };
}

function parseEmailList(raw: string): string[] {
  if (!raw) return [];
  const addresses: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of raw) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      addresses.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) addresses.push(current.trim());
  return addresses
    .map((addr) => parseEmailAddress(addr.trim()).email)
    .filter(Boolean);
}

// ── Gmail Batch API ──────────────────────────────────────────────────────────

/**
 * Fetch multiple Gmail messages in a single HTTP batch request.
 * Gmail batch endpoint accepts up to 100 individual requests per call.
 */
async function batchGetMessages(
  accessToken: string,
  messageIds: string[],
): Promise<Map<string, any>> {
  const BATCH_SIZE = 100;
  const results = new Map<string, any>();

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);
    const boundary = `batch_${Date.now()}_${i}`;

    const parts = batch
      .map(
        (id, idx) =>
          [
            `--${boundary}`,
            `Content-Type: application/http`,
            `Content-ID: <item${idx}>`,
            ``,
            `GET /gmail/v1/users/me/messages/${id}?format=full`,
            ``,
          ].join("\r\n"),
      )
      .join("\r\n");

    const body = `${parts}\r\n--${boundary}--`;

    const res = await fetch("https://www.googleapis.com/batch/gmail/v1", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/mixed; boundary=${boundary}`,
      },
      body,
    });

    if (!res.ok) {
      logger.error("Gmail batch request failed", {
        status: res.status,
        statusText: res.statusText,
        batchOffset: i,
      });
      continue;
    }

    const text = await res.text();
    const responseParts = text
      .split(/--batch_[^\r\n]+/)
      .filter((p) => p.includes("{"));
    for (const part of responseParts) {
      const jsonMatch = part.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const msg = JSON.parse(jsonMatch[0]);
          if (msg.id) results.set(msg.id, msg);
        } catch {
          // skip malformed JSON in batch response
        }
      }
    }
  }

  return results;
}

// ── Message row conversion ───────────────────────────────────────────────────

function messageToRow(
  msg: any,
  userId: string,
  userEmail: string | null,
): NewEmailRaw | null {
  if (!msg?.id || !msg?.threadId) return null;

  const headers = msg.payload?.headers || [];
  const fromRaw = getHeader(headers, "From");
  const toRaw = getHeader(headers, "To");
  const ccRaw = getHeader(headers, "Cc");
  const subject = getHeader(headers, "Subject");
  const dateStr = getHeader(headers, "Date");

  const { email: fromEmail, name: fromName } = parseEmailAddress(fromRaw);
  const date = dateStr ? new Date(dateStr) : new Date();
  const direction: "inbound" | "outbound" =
    userEmail && fromEmail.toLowerCase() === userEmail.toLowerCase()
      ? "outbound"
      : "inbound";

  const { html, plain } = extractBodyParts(msg.payload);
  const bodyMarkdown = htmlToMarkdown(html, plain);
  const bodySizeBytes = Buffer.byteLength(bodyMarkdown, "utf-8");

  const labels = (msg.labelIds || []) as string[];
  const attachments = hasAttachmentParts(msg.payload);

  const rawHeaders: Record<string, string> = {};
  for (const h of [
    "Message-ID",
    "In-Reply-To",
    "References",
    "Reply-To",
    "List-Unsubscribe",
  ]) {
    const val = getHeader(headers, h);
    if (val) rawHeaders[h] = val;
  }

  return {
    userId,
    gmailMessageId: msg.id,
    gmailThreadId: msg.threadId,
    subject,
    fromEmail,
    fromName: fromName || null,
    toEmails: parseEmailList(toRaw),
    ccEmails: ccRaw ? parseEmailList(ccRaw) : null,
    date,
    bodyMarkdown,
    bodySizeBytes,
    direction,
    hasAttachments: attachments,
    labels,
    rawHeaders: Object.keys(rawHeaders).length > 0 ? rawHeaders : null,
  };
}

// ── Main sync function ───────────────────────────────────────────────────────

/**
 * Sync emails from a user's Gmail account into emails_raw.
 * Uses Gmail's HTTP batch endpoint (100 messages/request) and batch DB inserts.
 * Does NOT classify threads — call computeThreadStates() separately.
 */
export async function syncEmails(
  userId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, skipped: 0, errors: 0, errorDetails: [] };

  const gmailResult = await getGmailClientForUser(userId);
  if (!gmailResult) {
    throw new Error(`No Gmail access for user ${userId}`);
  }
  const { client: gmail, email: userEmail, oauth2Client } = gmailResult;
  const { token: accessToken } = await oauth2Client.getAccessToken();
  if (!accessToken) {
    throw new Error(`Failed to obtain access token for user ${userId}`);
  }

  const query = options.query || "newer_than:7d";
  const maxMessages = options.maxMessages || 500;

  let allMessageIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(maxMessages - allMessageIds.length, 100),
      pageToken,
    });

    const messages = listRes.data.messages || [];
    allMessageIds.push(...messages.map((m: any) => m.id!).filter(Boolean));
    pageToken = listRes.data.nextPageToken || undefined;
  } while (pageToken && allMessageIds.length < maxMessages);

  allMessageIds = allMessageIds.slice(0, maxMessages);

  logger.info("Email sync: fetching messages via batch API", {
    userId,
    count: allMessageIds.length,
    query,
  });

  const BATCH_SIZE = 100;
  for (let i = 0; i < allMessageIds.length; i += BATCH_SIZE) {
    const batchIds = allMessageIds.slice(i, i + BATCH_SIZE);

    const messageMap = await batchGetMessages(accessToken, batchIds);

    const rows: NewEmailRaw[] = [];
    for (const id of batchIds) {
      const msg = messageMap.get(id);
      if (!msg) {
        const reason = "batch_api_miss: message ID listed but not returned by batch API";
        result.errorDetails.push({ gmailMessageId: id, reason });
        result.errors++;
        logError({
          errorName: "EmailSyncError",
          errorMessage: reason,
          errorCode: "email_sync_error",
          userId,
          context: { gmailMessageId: id },
        });
        continue;
      }
      try {
        const row = messageToRow(msg, userId, userEmail);
        if (row) {
          rows.push(row);
        } else {
          const reason = "messageToRow_null: missing required fields";
          result.errorDetails.push({ gmailMessageId: id, reason });
          result.errors++;
          logError({
            errorName: "EmailSyncError",
            errorMessage: reason,
            errorCode: "email_sync_error",
            userId,
            context: { gmailMessageId: id },
          });
        }
      } catch (err) {
        const reason = String(err);
        logger.warn("Failed to process message", {
          userId,
          msgId: id,
          error: reason,
        });
        result.errorDetails.push({ gmailMessageId: id, reason });
        result.errors++;
        logError({
          errorName: "EmailSyncError",
          errorMessage: reason,
          errorCode: "email_sync_error",
          userId,
          context: { gmailMessageId: id },
        });
      }
    }

    if (rows.length > 0) {
      try {
        const insertResult = await db
          .insert(emailsRaw)
          .values(rows)
          .onConflictDoNothing({
            target: [emailsRaw.userId, emailsRaw.gmailMessageId],
          });
        result.synced += insertResult.rowCount ?? 0;
        result.skipped += rows.length - (insertResult.rowCount ?? 0);
      } catch (err) {
        logger.error("Batch DB insert failed", {
          userId,
          batchOffset: i,
          rowCount: rows.length,
          error: String(err),
        });
        result.errors += rows.length;
      }
    }

    logger.info("Email sync: batch progress", {
      userId,
      fetched: Math.min(i + BATCH_SIZE, allMessageIds.length),
      total: allMessageIds.length,
      synced: result.synced,
      skipped: result.skipped,
    });
  }

  logger.info("Email sync completed", { userId, ...result });
  return result;
}

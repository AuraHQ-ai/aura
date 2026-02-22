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

// ── Types ───────────────────────────────────────────────────────────────────

export interface SyncOptions {
  /** Gmail search query, e.g. "newer_than:7d" */
  query?: string;
  /** Max number of messages to fetch per call (default 500) */
  maxMessages?: number;
}

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: number;
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

// ── Gmail Batch Fetch ────────────────────────────────────────

/**
 * Sync emails from a user's Gmail account into emails_raw.
 * Fetches messages, converts HTML→markdown, and upserts rows.
 * Does NOT run triage — call triageEmails() separately.
 */
export async function syncEmails(
  userId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, skipped: 0, errors: 0 };

  const gmailResult = await getGmailClientForUser(userId);
  if (!gmailResult) {
    throw new Error(`No Gmail access for user ${userId}`);
  }
  const { client: gmail, email: userEmail } = gmailResult;

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

  logger.info("Email sync: fetching messages", {
    userId,
    count: allMessageIds.length,
    query,
  });

  const BATCH_SIZE = 20;
  for (let i = 0; i < allMessageIds.length; i += BATCH_SIZE) {
    const batch = allMessageIds.slice(i, i + BATCH_SIZE);
    const fullMessages = await Promise.all(
      batch.map(async (id) => {
        try {
          const res = await gmail.users.messages.get({
            userId: "me",
            id,
            format: "full",
          });
          return res.data;
        } catch (err: any) {
          logger.error("Failed to fetch message", {
            messageId: id,
            error: err.message,
          });
          result.errors++;
          return null;
        }
      }),
    );

    for (const msg of fullMessages) {
      if (!msg?.id || !msg?.threadId) continue;

      try {
        const headers = msg.payload?.headers || [];
        const fromRaw = getHeader(headers, "From");
        const toRaw = getHeader(headers, "To");
        const ccRaw = getHeader(headers, "Cc");
        const subject = getHeader(headers, "Subject");
        const dateStr = getHeader(headers, "Date");

        const { email: fromEmail, name: fromName } =
          parseEmailAddress(fromRaw);
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

        const row: NewEmailRaw = {
          userId,
          gmailMessageId: msg.id!,
          gmailThreadId: msg.threadId!,
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
          rawHeaders:
            Object.keys(rawHeaders).length > 0 ? rawHeaders : null,
        };

        const insertResult = await db
          .insert(emailsRaw)
          .values(row)
          .onConflictDoNothing({
            target: [emailsRaw.userId, emailsRaw.gmailMessageId],
          });

        if (insertResult.rowCount === 0) {
          result.skipped++;
        } else {
          result.synced++;
        }
      } catch (err) {
        logger.warn("Failed to process message", {
          userId,
          msgId: msg.id,
          error: String(err),
        });
        result.errors++;
      }
    }
  }

  logger.info("Email sync completed", { userId, ...result });
  return result;
}

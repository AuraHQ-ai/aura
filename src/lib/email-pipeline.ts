import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface RawGmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: { name?: string; value?: string }[];
    body?: { data?: string };
    parts?: any[];
    mimeType?: string;
  };
}

interface ParsedEmail {
  gmailMessageId: string;
  gmailThreadId: string;
  subject: string | null;
  fromEmail: string | null;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  date: Date | null;
  bodyMarkdown: string | null;
  bodyRaw: string | null;
  snippet: string | null;
  labelIds: string[];
  isInbound: boolean;
}

export interface ThreadStatus {
  gmailThreadId: string;
  subject: string | null;
  latestDate: Date | null;
  latestFromEmail: string | null;
  triageClass: string | null;
  messageCount: number;
}

export interface EmailDigestResult {
  awaitingReply: ThreadStatus[];
  urgentMissed: Array<{
    gmailMessageId: string;
    subject: string | null;
    fromEmail: string | null;
    date: Date | null;
    triageClass: string | null;
    triageReason: string | null;
  }>;
  summary: {
    totalEmails: number;
    untriaged: number;
    urgent: number;
    actionable: number;
    informational: number;
    noise: number;
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getHeader(
  headers: { name?: string; value?: string }[] | undefined,
  name: string,
): string {
  if (!headers) return "";
  const h = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

function parseEmailAddress(raw: string): { email: string; name: string } {
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1]!.trim().replace(/^["']|["']$/g, ""), email: match[2]!.trim() };
  }
  return { name: "", email: raw.trim() };
}

function parseAddressList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((addr) => parseEmailAddress(addr.trim()).email)
    .filter(Boolean);
}

function extractHtmlBody(payload: any): string {
  if (!payload) return "";

  if (payload.mimeType === "text/html" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
    }

    for (const part of payload.parts) {
      if (part.mimeType?.startsWith("multipart/")) {
        const nested = extractHtmlBody(part);
        if (nested) return nested;
      }
    }

    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractHtmlBody(part);
        if (nested) return nested;
      }
    }
  }

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  return "";
}

function extractPlainTextBody(payload: any): string {
  if (!payload) return "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
    }

    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractPlainTextBody(part);
        if (nested) return nested;
      }
    }
  }

  return "";
}

async function htmlToMarkdown(html: string): Promise<string> {
  if (!html) return "";
  const TurndownService = (await import("turndown")).default;
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  return td.turndown(html);
}

// ── Gmail Batch Sync ────────────────────────────────────────────────────────

/**
 * Fetch and upsert all emails for a user since a given date.
 * Uses the existing Gmail OAuth from gmail.ts.
 */
export async function syncUserEmails(
  userId: string,
  sinceDate: Date,
): Promise<{ synced: number; errors: number }> {
  const { getGmailClientForUser } = await import("./gmail.js");
  const result = await getGmailClientForUser(userId);
  if (!result) {
    return { synced: 0, errors: 0 };
  }

  const { client: gmailClient, email: userEmail } = result;
  const after = Math.floor(sinceDate.getTime() / 1000);
  const query = `after:${after}`;

  let synced = 0;
  let errors = 0;
  let pageToken: string | undefined;

  do {
    const listRes = await gmailClient.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 100,
      pageToken,
    });

    const messageStubs = listRes.data.messages || [];
    if (messageStubs.length === 0) break;

    const batchSize = 20;
    for (let i = 0; i < messageStubs.length; i += batchSize) {
      const batch = messageStubs.slice(i, i + batchSize);
      const fullMessages = await Promise.all(
        batch.map(async (stub) => {
          try {
            const msg = await gmailClient.users.messages.get({
              userId: "me",
              id: stub.id!,
              format: "full",
            });
            return msg.data as RawGmailMessage;
          } catch (err: any) {
            logger.error("Failed to fetch message", {
              messageId: stub.id,
              error: err.message,
            });
            errors++;
            return null;
          }
        }),
      );

      const validMessages = fullMessages.filter(
        (m): m is RawGmailMessage => m !== null,
      );

      const parsed = await Promise.all(
        validMessages.map((msg) => parseGmailMessage(msg, userEmail)),
      );

      await upsertEmails(userId, parsed);
      synced += parsed.length;
    }

    pageToken = listRes.data.nextPageToken || undefined;
  } while (pageToken);

  logger.info("Email sync completed", { userId, synced, errors });
  return { synced, errors };
}

async function parseGmailMessage(
  msg: RawGmailMessage,
  userEmail: string | null,
): Promise<ParsedEmail> {
  const headers = msg.payload?.headers || [];
  const fromRaw = getHeader(headers, "From");
  const { email: fromEmail, name: fromName } = parseEmailAddress(fromRaw);
  const toRaw = getHeader(headers, "To");
  const ccRaw = getHeader(headers, "Cc");
  const dateStr = getHeader(headers, "Date");

  const htmlBody = extractHtmlBody(msg.payload);
  const bodyRaw = htmlBody || null;
  let bodyMarkdown: string | null = null;

  if (htmlBody) {
    try {
      bodyMarkdown = await htmlToMarkdown(htmlBody);
    } catch {
      bodyMarkdown = extractPlainTextBody(msg.payload) || null;
    }
  } else {
    bodyMarkdown = extractPlainTextBody(msg.payload) || null;
  }

  const isInbound = userEmail
    ? fromEmail.toLowerCase() !== userEmail.toLowerCase()
    : true;

  let parsedDate: Date | null = null;
  if (dateStr) {
    try {
      parsedDate = new Date(dateStr);
      if (isNaN(parsedDate.getTime())) parsedDate = null;
    } catch {
      parsedDate = null;
    }
  }

  return {
    gmailMessageId: msg.id,
    gmailThreadId: msg.threadId,
    subject: getHeader(headers, "Subject") || null,
    fromEmail: fromEmail || null,
    fromName: fromName || null,
    toEmails: parseAddressList(toRaw),
    ccEmails: parseAddressList(ccRaw),
    date: parsedDate,
    bodyMarkdown,
    bodyRaw,
    snippet: msg.snippet || null,
    labelIds: msg.labelIds || [],
    isInbound,
  };
}

async function upsertEmails(
  userId: string,
  emails: ParsedEmail[],
): Promise<void> {
  if (emails.length === 0) return;

  const { db } = await import("../db/client.js");
  const { emailsRaw } = await import("../db/schema.js");

  for (const email of emails) {
    await db
      .insert(emailsRaw)
      .values({
        userId,
        gmailMessageId: email.gmailMessageId,
        gmailThreadId: email.gmailThreadId,
        subject: email.subject,
        fromEmail: email.fromEmail,
        fromName: email.fromName,
        toEmails: email.toEmails,
        ccEmails: email.ccEmails,
        date: email.date,
        bodyMarkdown: email.bodyMarkdown,
        bodyRaw: email.bodyRaw,
        snippet: email.snippet,
        labelIds: email.labelIds,
        isInbound: email.isInbound,
      })
      .onConflictDoUpdate({
        target: [emailsRaw.userId, emailsRaw.gmailMessageId],
        set: {
          subject: email.subject,
          fromEmail: email.fromEmail,
          fromName: email.fromName,
          toEmails: email.toEmails,
          ccEmails: email.ccEmails,
          date: email.date,
          bodyMarkdown: email.bodyMarkdown,
          bodyRaw: email.bodyRaw,
          snippet: email.snippet,
          labelIds: email.labelIds,
          isInbound: email.isInbound,
        },
      });
  }
}

// ── Haiku Triage Gate ───────────────────────────────────────────────────────

const TRIAGE_BATCH_SIZE = 50;
const TRIAGE_MODEL = "claude-haiku-4-20250514";

interface TriageResult {
  gmail_message_id: string;
  triage_class: "urgent" | "actionable" | "informational" | "noise";
  reason: string;
}

/**
 * Read untriaged emails and classify them using Claude Haiku.
 * Processes in batches of 50.
 */
export async function triageEmails(
  userId: string,
): Promise<{ triaged: number; errors: number }> {
  const { db } = await import("../db/client.js");
  const { emailsRaw } = await import("../db/schema.js");
  const { eq, and, isNull } = await import("drizzle-orm");

  const untriaged = await db
    .select({
      id: emailsRaw.id,
      gmailMessageId: emailsRaw.gmailMessageId,
      subject: emailsRaw.subject,
      fromEmail: emailsRaw.fromEmail,
      fromName: emailsRaw.fromName,
      snippet: emailsRaw.snippet,
      bodyMarkdown: emailsRaw.bodyMarkdown,
      isInbound: emailsRaw.isInbound,
      date: emailsRaw.date,
    })
    .from(emailsRaw)
    .where(
      and(eq(emailsRaw.userId, userId), isNull(emailsRaw.triageClass)),
    )
    .limit(500);

  if (untriaged.length === 0) {
    return { triaged: 0, errors: 0 };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error("ANTHROPIC_API_KEY not set, cannot triage emails");
    return { triaged: 0, errors: 0 };
  }

  let triaged = 0;
  let errors = 0;

  for (let i = 0; i < untriaged.length; i += TRIAGE_BATCH_SIZE) {
    const batch = untriaged.slice(i, i + TRIAGE_BATCH_SIZE);

    const emailSummaries = batch.map((e) => ({
      gmail_message_id: e.gmailMessageId,
      subject: e.subject || "(no subject)",
      from: e.fromName
        ? `${e.fromName} <${e.fromEmail}>`
        : e.fromEmail || "unknown",
      is_inbound: e.isInbound,
      date: e.date?.toISOString() || "unknown",
      preview: (e.bodyMarkdown || e.snippet || "").slice(0, 500),
    }));

    try {
      const results = await callTriageApi(apiKey, emailSummaries);

      for (const result of results) {
        const email = batch.find(
          (e) => e.gmailMessageId === result.gmail_message_id,
        );
        if (!email) continue;

        await db
          .update(emailsRaw)
          .set({
            triageClass: result.triage_class,
            triageReason: result.reason,
            triageModel: TRIAGE_MODEL,
            triagedAt: new Date(),
          })
          .where(eq(emailsRaw.id, email.id));

        triaged++;
      }
    } catch (err: any) {
      logger.error("Triage batch failed", {
        batchStart: i,
        error: err.message,
      });
      errors += batch.length;
    }
  }

  logger.info("Triage completed", { userId, triaged, errors });
  return { triaged, errors };
}

async function callTriageApi(
  apiKey: string,
  emails: Array<{
    gmail_message_id: string;
    subject: string;
    from: string;
    is_inbound: boolean | null;
    date: string;
    preview: string;
  }>,
): Promise<TriageResult[]> {
  const prompt = `Classify each email below into exactly one of: urgent, actionable, informational, noise.

- **urgent**: Requires immediate attention — time-sensitive requests, critical issues, important deadlines within 24h
- **actionable**: Needs a reply or action but not time-critical — questions, requests, follow-ups
- **informational**: Worth reading but no action needed — updates, newsletters with relevant content, FYI messages
- **noise**: Not worth reading — marketing spam, automated notifications, bulk emails

For each email, output a JSON object with:
- "gmail_message_id": the message ID
- "triage_class": one of "urgent", "actionable", "informational", "noise"
- "reason": a one-line explanation

Output ONLY a JSON array of objects. No other text.

Emails to classify:
${JSON.stringify(emails, null, 2)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: TRIAGE_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
  };

  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock?.text) {
    throw new Error("No text content in Anthropic response");
  }

  const jsonMatch = textBlock.text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("Could not parse JSON array from response");
  }

  return JSON.parse(jsonMatch[0]) as TriageResult[];
}

// ── Thread Status Computation ───────────────────────────────────────────────

/**
 * Find threads awaiting reply: the latest message is inbound
 * and triaged as urgent or actionable.
 */
export async function getThreadsAwaitingReply(
  userId: string,
): Promise<ThreadStatus[]> {
  const { db } = await import("../db/client.js");
  const { emailsRaw } = await import("../db/schema.js");
  const { eq, sql } = await import("drizzle-orm");

  const threads = await db.execute<{
    gmail_thread_id: string;
    subject: string | null;
    latest_date: Date | null;
    latest_from_email: string | null;
    triage_class: string | null;
    is_inbound: boolean | null;
    message_count: number;
  }>(sql`
    WITH ranked AS (
      SELECT
        gmail_thread_id,
        subject,
        date,
        from_email,
        triage_class,
        is_inbound,
        ROW_NUMBER() OVER (PARTITION BY gmail_thread_id ORDER BY date DESC) AS rn,
        COUNT(*) OVER (PARTITION BY gmail_thread_id) AS message_count
      FROM emails_raw
      WHERE user_id = ${userId}
    )
    SELECT
      gmail_thread_id,
      subject,
      date AS latest_date,
      from_email AS latest_from_email,
      triage_class,
      is_inbound,
      message_count
    FROM ranked
    WHERE rn = 1
      AND is_inbound = true
      AND triage_class IN ('urgent', 'actionable')
    ORDER BY
      CASE WHEN triage_class = 'urgent' THEN 0 ELSE 1 END,
      date DESC
  `);

  return threads.rows.map((row) => ({
    gmailThreadId: row.gmail_thread_id,
    subject: row.subject,
    latestDate: row.latest_date,
    latestFromEmail: row.latest_from_email,
    triageClass: row.triage_class,
    messageCount: Number(row.message_count),
  }));
}

// ── Email Digest ────────────────────────────────────────────────────────────

/**
 * Produce a digest of the user's email state:
 * - Threads awaiting reply (sorted by urgency)
 * - Urgent items that may have been missed
 * - Summary counts
 */
export async function getEmailDigest(
  userId: string,
): Promise<EmailDigestResult> {
  const { db } = await import("../db/client.js");
  const { emailsRaw } = await import("../db/schema.js");
  const { eq, and, isNull, sql } = await import("drizzle-orm");

  const awaitingReply = await getThreadsAwaitingReply(userId);

  const urgentMissed = await db
    .select({
      gmailMessageId: emailsRaw.gmailMessageId,
      subject: emailsRaw.subject,
      fromEmail: emailsRaw.fromEmail,
      date: emailsRaw.date,
      triageClass: emailsRaw.triageClass,
      triageReason: emailsRaw.triageReason,
    })
    .from(emailsRaw)
    .where(
      and(
        eq(emailsRaw.userId, userId),
        eq(emailsRaw.isInbound, true),
        sql`${emailsRaw.triageClass} = 'urgent'`,
        sql`${emailsRaw.labelIds} @> ARRAY['UNREAD']::text[]`,
      ),
    )
    .orderBy(sql`${emailsRaw.date} DESC`)
    .limit(20);

  const [counts] = await db
    .select({
      total: sql<number>`COUNT(*)`,
      untriaged: sql<number>`COUNT(*) FILTER (WHERE ${emailsRaw.triageClass} IS NULL)`,
      urgent: sql<number>`COUNT(*) FILTER (WHERE ${emailsRaw.triageClass} = 'urgent')`,
      actionable: sql<number>`COUNT(*) FILTER (WHERE ${emailsRaw.triageClass} = 'actionable')`,
      informational: sql<number>`COUNT(*) FILTER (WHERE ${emailsRaw.triageClass} = 'informational')`,
      noise: sql<number>`COUNT(*) FILTER (WHERE ${emailsRaw.triageClass} = 'noise')`,
    })
    .from(emailsRaw)
    .where(eq(emailsRaw.userId, userId));

  return {
    awaitingReply,
    urgentMissed,
    summary: {
      totalEmails: Number(counts?.total ?? 0),
      untriaged: Number(counts?.untriaged ?? 0),
      urgent: Number(counts?.urgent ?? 0),
      actionable: Number(counts?.actionable ?? 0),
      informational: Number(counts?.informational ?? 0),
      noise: Number(counts?.noise ?? 0),
    },
  };
}

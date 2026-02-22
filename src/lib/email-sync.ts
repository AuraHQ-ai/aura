import { generateText, Output } from "ai";
import { z } from "zod";
import { getFastModel } from "./ai.js";
import { getGmailClientForUser, getHeader, extractBody } from "./gmail.js";
import { logger } from "./logger.js";
import type { NewEmailRaw } from "../db/schema.js";

// ── HTML-to-Markdown ────────────────────────────────────────────────────────

let turndownInstance: any = null;

async function getTurndown() {
  if (turndownInstance) return turndownInstance;

  const mod = await import("turndown");
  const TurndownService = (mod as any).default || mod;
  turndownInstance = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });

  turndownInstance.addRule("removeStyles", {
    filter: ["style", "script", "link", "meta"] as any,
    replacement: () => "",
  });

  return turndownInstance;
}

export async function htmlToMarkdown(html: string): Promise<string> {
  const td = await getTurndown();
  return td.turndown(html).trim();
}

const HTML_TAG_RE = /<[a-z][\s\S]*?>/i;

function extractEmailAddress(headerValue: string): string {
  const match = headerValue.match(/<([^>]+)>/);
  return (match ? match[1] : headerValue).trim().toLowerCase();
}

// ── Triage Gate ─────────────────────────────────────────────────────────────

const triageSchema = z.object({
  results: z.array(z.object({
    messageId: z.string(),
    triage: z.enum(["junk", "fyi", "actionable", "urgent"]),
  })),
});

export async function triageEmails(
  emails: { gmailMessageId: string; from: string; subject: string; snippet: string }[],
): Promise<Map<string, "junk" | "fyi" | "actionable" | "urgent">> {
  const BATCH_SIZE = 50;
  const results = new Map<string, "junk" | "fyi" | "actionable" | "urgent">();

  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    const model = await getFastModel();

    const { output: object } = await generateText({
      model,
      output: Output.object({ schema: triageSchema }),
      system: `You are an email triage classifier for a busy startup CEO/co-founder.
Classify each email into exactly one category:
- junk: automated notifications, marketing, newsletters, social media alerts, promotional
- fyi: informational but no action needed — internal updates, read receipts, calendar confirmations
- actionable: someone is waiting for a response, needs a decision, or requires action
- urgent: money (invoices, billing failures, payment issues), legal (GDPR, contracts), infrastructure alerts (server down, webhook failures), investors, expiring deadlines

When in doubt between actionable and urgent, prefer actionable.
When in doubt between junk and fyi, prefer junk.`,
      prompt: `Classify these emails:\n${batch.map((e, idx) => `${idx + 1}. [${e.gmailMessageId}] From: ${e.from} | Subject: ${e.subject} | Snippet: ${e.snippet}`).join("\n")}`,
    });

    if (object?.results) {
      for (const r of object.results) {
        results.set(r.messageId, r.triage);
      }
    }
  }

  return results;
}

// ── Main Sync Function ──────────────────────────────────────────────────────

export async function syncEmailsForUser(
  userId: string,
  options?: { after?: string; maxEmails?: number },
): Promise<{ fetched: number; triaged: number; errors: number }> {
  const result = await getGmailClientForUser(userId);
  if (!result) {
    throw new Error(`No Gmail access for user ${userId}. They need to authorize Aura via OAuth.`);
  }
  const { client: gmail, email: userEmail } = result;

  const ownerEmail = userEmail?.toLowerCase() || "";

  const afterDate = options?.after || "2025/01/01";
  const maxEmails = options?.maxEmails || 5000;

  // 1. List all message IDs (paginate)
  const messageStubs: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;

  do {
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: `after:${afterDate} -in:trash -in:spam`,
      maxResults: 100,
      pageToken,
    });

    for (const msg of listRes.data.messages || []) {
      if (msg.id && msg.threadId) {
        messageStubs.push({ id: msg.id, threadId: msg.threadId });
      }
    }

    pageToken = listRes.data.nextPageToken || undefined;
    if (messageStubs.length >= maxEmails) break;
    if (pageToken) await new Promise((r) => setTimeout(r, 100));
  } while (pageToken);

  logger.info(`Email sync: listed ${messageStubs.length} messages for user ${userId}`);

  // 2. Filter out already-synced messages
  const { db } = await import("../db/client.js");
  const { emailsRaw } = await import("../db/schema.js");
  const { eq, and, inArray } = await import("drizzle-orm");

  const allGmailIds = messageStubs.map((m) => m.id);
  const existingIds = new Set<string>();

  for (let i = 0; i < allGmailIds.length; i += 500) {
    const batch = allGmailIds.slice(i, i + 500);
    const rows = await db
      .select({ gmailMessageId: emailsRaw.gmailMessageId })
      .from(emailsRaw)
      .where(
        and(
          eq(emailsRaw.userId, userId),
          inArray(emailsRaw.gmailMessageId, batch),
        ),
      );
    for (const row of rows) {
      existingIds.add(row.gmailMessageId);
    }
  }

  const newStubs = messageStubs.filter((m) => !existingIds.has(m.id));
  logger.info(`Email sync: ${newStubs.length} new messages to fetch (${existingIds.size} already synced)`);

  // 3. Fetch full details for new messages and upsert
  let fetched = 0;
  let errors = 0;

  for (const stub of newStubs) {
    try {
      const msgRes = await gmail.users.messages.get({
        userId: "me",
        id: stub.id,
        format: "full",
      });

      const headers = msgRes.data.payload?.headers || [];
      const fromAddr = getHeader(headers, "From");
      const toAddr = getHeader(headers, "To");
      const ccAddr = getHeader(headers, "Cc");
      const subject = getHeader(headers, "Subject");
      const dateStr = getHeader(headers, "Date");
      const snippet = msgRes.data.snippet || "";
      const labelIds = msgRes.data.labelIds || [];

      let body = extractBody(msgRes.data.payload || {});
      if (body && HTML_TAG_RE.test(body)) {
        body = await htmlToMarkdown(body);
      }

      const direction = labelIds.includes("SENT")
        || (ownerEmail && extractEmailAddress(fromAddr) === ownerEmail)
        ? "outbound"
        : "inbound";

      const emailRecord: NewEmailRaw = {
        userId,
        gmailMessageId: stub.id,
        gmailThreadId: stub.threadId,
        from: fromAddr,
        to: toAddr || null,
        cc: ccAddr || null,
        subject: subject || null,
        snippet: snippet || null,
        bodyMarkdown: body || null,
        date: dateStr ? new Date(dateStr) : null,
        labels: labelIds,
        isUnread: labelIds.includes("UNREAD"),
        direction,
      };

      await db.insert(emailsRaw).values(emailRecord).onConflictDoNothing();
      fetched++;

      if (fetched % 50 === 0) {
        logger.info(`Email sync: fetched ${fetched}/${newStubs.length} messages`);
      }

      await new Promise((r) => setTimeout(r, 100));
    } catch (err) {
      errors++;
      logger.error("Email sync: failed to fetch message", {
        messageId: stub.id,
        error: String(err),
      });
    }
  }

  // 4. Triage untriaged emails
  const { isNull } = await import("drizzle-orm");
  const untriaged = await db
    .select({
      gmailMessageId: emailsRaw.gmailMessageId,
      from: emailsRaw.from,
      subject: emailsRaw.subject,
      snippet: emailsRaw.snippet,
    })
    .from(emailsRaw)
    .where(
      and(
        eq(emailsRaw.userId, userId),
        isNull(emailsRaw.triage),
      ),
    )
    .limit(500);

  let triaged = 0;
  if (untriaged.length > 0) {
    logger.info(`Email sync: triaging ${untriaged.length} emails`);

    const triageInput = untriaged.map((e) => ({
      gmailMessageId: e.gmailMessageId,
      from: e.from,
      subject: e.subject || "",
      snippet: e.snippet || "",
    }));

    let triageResults: Map<string, "junk" | "fyi" | "actionable" | "urgent">;
    try {
      triageResults = await triageEmails(triageInput);
    } catch (err) {
      logger.error("Email sync: triage failed, skipping", { error: String(err) });
      triageResults = new Map();
    }

    for (const [msgId, triageValue] of triageResults) {
      try {
        await db
          .update(emailsRaw)
          .set({ triage: triageValue })
          .where(
            and(
              eq(emailsRaw.userId, userId),
              eq(emailsRaw.gmailMessageId, msgId),
            ),
          );
        triaged++;
      } catch (err) {
        errors++;
        logger.error("Email sync: failed to update triage", {
          messageId: msgId,
          error: String(err),
        });
      }
    }
  }

  logger.info(`Email sync complete for ${userId}: ${fetched} fetched, ${triaged} triaged, ${errors} errors`);
  return { fetched, triaged, errors };
}

// ── Thread Status ───────────────────────────────────────────────────────────

export async function getThreadsAwaitingReply(userId: string): Promise<{
  threadId: string;
  subject: string;
  lastFrom: string;
  lastDate: Date;
  triage: string;
}[]> {
  const { db } = await import("../db/client.js");
  const { emailsRaw } = await import("../db/schema.js");
  const { sql } = await import("drizzle-orm");

  // For each thread, get the most recent email.
  // If it's inbound and actionable/urgent, the thread awaits reply.
  const rows = await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (gmail_thread_id)
        gmail_thread_id,
        subject,
        from_address,
        date,
        direction,
        triage
      FROM emails_raw
      WHERE user_id = ${userId}
      ORDER BY gmail_thread_id, date DESC NULLS LAST
    )
    SELECT
      gmail_thread_id AS "threadId",
      subject,
      from_address AS "lastFrom",
      date AS "lastDate",
      triage
    FROM latest
    WHERE direction = 'inbound'
      AND triage IN ('actionable', 'urgent')
    ORDER BY
      CASE triage WHEN 'urgent' THEN 0 ELSE 1 END,
      date DESC NULLS LAST
  `);

  return (rows.rows as any[]).map((r) => ({
    threadId: r.threadId,
    subject: r.subject || "(no subject)",
    lastFrom: r.lastFrom,
    lastDate: r.lastDate ? new Date(r.lastDate) : new Date(),
    triage: r.triage,
  }));
}

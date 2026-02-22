import { generateObject } from "ai";
import { z } from "zod";
import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { emailsRaw } from "../db/schema.js";
import { getFastModel } from "./ai.js";
import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface TriageSummary {
  triaged: number;
  errors: number;
  breakdown: Record<string, number>;
  lastError?: string;
}

// ── Zod schema for structured output ────────────────────────────────────────

const triageResultSchema = z.object({
  id: z.string(),
  triage: z.enum(["junk", "fyi", "actionable", "urgent"]),
  reason: z.string(),
});

const triageBatchSchema = z.object({
  results: z.array(triageResultSchema),
});

// ── Haiku Triage Gate ───────────────────────────────────────────────────────

const TRIAGE_PROMPT = `You are an email triage assistant. Classify each email into exactly one category:

- **junk**: spam, marketing, newsletters, automated notifications, no action needed
- **fyi**: informational, worth seeing but no reply needed (order confirmations, status updates, CC'd threads)
- **actionable**: requires a response or action within a reasonable timeframe
- **urgent**: time-sensitive, needs immediate attention (client escalations, broken systems, deadlines today)

For each email, return an object with "id", "triage" (the category), and "reason" (one-line explanation).`;

/**
 * Triage un-classified emails in emails_raw using Claude Haiku.
 * Processes in batches of up to 50.
 */
export async function triageEmails(
  userId: string,
  options: { batchSize?: number; limit?: number } = {},
): Promise<TriageSummary> {
  const batchSize = options.batchSize ?? 50;
  const limit = options.limit ?? 500;
  const summary: TriageSummary = { triaged: 0, errors: 0, breakdown: {} };

  const untriaged = await db
    .select({
      id: emailsRaw.id,
      subject: emailsRaw.subject,
      fromEmail: emailsRaw.fromEmail,
      fromName: emailsRaw.fromName,
      direction: emailsRaw.direction,
      bodyMarkdown: emailsRaw.bodyMarkdown,
      labels: emailsRaw.labels,
    })
    .from(emailsRaw)
    .where(and(eq(emailsRaw.userId, userId), isNull(emailsRaw.triage)))
    .limit(limit);

  if (untriaged.length === 0) {
    logger.info("No untriaged emails found", { userId });
    return summary;
  }

  logger.info("Triaging emails", {
    userId,
    count: untriaged.length,
    batchSize,
  });

  for (let i = 0; i < untriaged.length; i += batchSize) {
    const batch = untriaged.slice(i, i + batchSize);

    const emailDescriptions = batch.map((email) => {
      const bodyPreview = (email.bodyMarkdown || "").slice(0, 500);
      const fromDisplay = email.fromName
        ? `${email.fromName} <${email.fromEmail}>`
        : email.fromEmail;
      const labelsStr =
        (email.labels as string[] | null)?.join(", ") || "none";
      return [
        "ID: " + email.id,
        "Subject: " + (email.subject || "(no subject)"),
        "From: " + fromDisplay,
        "Direction: " + email.direction,
        "Labels: " + labelsStr,
        "Body preview: " + bodyPreview,
      ].join("\n");
    });

    const prompt =
      TRIAGE_PROMPT +
      "\n\nHere are " +
      batch.length +
      " emails to classify:\n\n" +
      emailDescriptions.join("\n---\n");

    try {
      const model = await getFastModel();
      const { object } = await generateObject({
        model,
        schema: triageBatchSchema,
        prompt,
        maxOutputTokens: 2000,
      });

      if (object.results.length > 0) {
        const valueRows = object.results.map(
          (r) => sql`(${r.id}::uuid, ${r.triage}, ${r.reason})`,
        );

        const updated = await db.execute(sql`
          UPDATE emails_raw SET
            triage = v.triage,
            triage_reason = v.reason,
            updated_at = now()
          FROM (VALUES ${sql.join(valueRows, sql`, `)}) AS v(id, triage, reason)
          WHERE emails_raw.id = v.id
            AND emails_raw.user_id = ${userId}
          RETURNING emails_raw.id, v.triage AS triage_cat
        `);

        const updatedIds = new Set<string>();
        for (const row of updated.rows as { id: string; triage_cat: string }[]) {
          updatedIds.add(row.id);
          summary.triaged++;
          summary.breakdown[row.triage_cat] =
            (summary.breakdown[row.triage_cat] || 0) + 1;
        }

        for (const r of object.results) {
          if (!updatedIds.has(r.id)) {
            logger.warn("Triage update matched no rows", {
              id: r.id,
              userId,
            });
            summary.errors++;
          }
        }
      }
    } catch (err) {
      const errStr = String(err);
      logger.error("Triage batch failed", {
        userId,
        batchStart: i,
        error: errStr,
      });
      summary.errors += batch.length;
      summary.lastError = errStr;
    }
  }

  logger.info("Email triage completed", { userId, ...summary });
  return summary;
}

import { generateObject } from "ai";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { emailsRaw } from "@aura/db/schema";
import { getFastModel } from "./ai.js";
import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export const threadStateValues = [
  "junk",
  "resolved",
  "awaiting_your_reply",
  "awaiting_their_reply",
  "fyi",
] as const;

export type ThreadState = (typeof threadStateValues)[number];

export interface ThreadStateSummary {
  processed: number;
  errors: number;
  breakdown: Record<string, number>;
  lastError?: string;
}

// ── Zod schema for structured output ────────────────────────────────────────

const threadStateSchema = z.object({
  state: z.enum(threadStateValues),
  reason: z.string(),
});

// ── Thread reconstruction ───────────────────────────────────────────────────

interface EmailRow {
  id: string;
  gmailThreadId: string;
  subject: string | null;
  fromEmail: string;
  fromName: string | null;
  date: Date;
  direction: string;
  bodyMarkdown: string | null;
  threadState: string | null;
  threadStateUpdatedAt: Date | null;
}

function reconstructThread(emails: EmailRow[]): string {
  const sorted = [...emails].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );

  const participants = [
    ...new Set(sorted.map((e) => e.fromEmail)),
  ].join(", ");

  const subject = sorted[0]?.subject || "(no subject)";

  const messages = sorted.map((e) => {
    const ts = e.date.toISOString().replace("T", " ").slice(0, 16);
    const direction = e.direction === "inbound" ? "inbound" : "outbound";
    const body = (e.bodyMarkdown || "").slice(0, 800);
    return `[${ts}] ${e.fromEmail} (${direction}):\n${body}`;
  });

  return [
    `Thread: ${subject}`,
    `Participants: ${participants}`,
    "",
    ...messages,
  ].join("\n");
}

// ── Prompt ──────────────────────────────────────────────────────────────────

function buildPrompt(threadText: string, userName: string): string {
  return `What is the state of this email thread for ${userName}? Classify as exactly one of:

- **junk**: spam, automated noise, marketing, irrelevant notifications
- **resolved**: conversation is done — thanks, confirmation, acknowledgment, no pending action
- **awaiting_your_reply**: someone asked ${userName} something or sent something that warrants a response
- **awaiting_their_reply**: ${userName} asked for something or requested action, waiting on the other party
- **fyi**: informational thread, no response expected from anyone

Explain in one sentence.

---

${threadText}`;
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Compute thread-level states for all email threads belonging to a user.
 * Only processes threads that have NULL thread_state or where new emails
 * arrived since the last computation.
 */
export async function computeThreadStates(
  userId: string,
): Promise<ThreadStateSummary> {
  const summary: ThreadStateSummary = {
    processed: 0,
    errors: 0,
    breakdown: {},
  };

  // Phase 1: fetch lightweight metadata to identify which threads need processing
  const metaRows = await db
    .select({
      gmailThreadId: emailsRaw.gmailThreadId,
      fromEmail: emailsRaw.fromEmail,
      fromName: emailsRaw.fromName,
      date: emailsRaw.date,
      direction: emailsRaw.direction,
      threadState: emailsRaw.threadState,
      threadStateUpdatedAt: emailsRaw.threadStateUpdatedAt,
    })
    .from(emailsRaw)
    .where(eq(emailsRaw.userId, userId));

  if (metaRows.length === 0) {
    logger.info("No emails found for user", { userId });
    return summary;
  }

  const threadMeta = new Map<string, typeof metaRows>();
  for (const row of metaRows) {
    const list = threadMeta.get(row.gmailThreadId) || [];
    list.push(row);
    threadMeta.set(row.gmailThreadId, list);
  }

  const threadIdsToProcess: string[] = [];
  for (const [threadId, rows] of threadMeta) {
    const maxEmailDate = Math.max(...rows.map((e) => e.date.getTime()));
    const lastUpdated = rows[0]?.threadStateUpdatedAt?.getTime() ?? 0;
    const hasNullState = rows.some((e) => e.threadState === null);

    if (hasNullState || maxEmailDate > lastUpdated) {
      threadIdsToProcess.push(threadId);
    }
  }

  if (threadIdsToProcess.length === 0) {
    logger.info("All threads already classified", { userId });
    return summary;
  }

  const MAX_THREADS_PER_RUN = 100;
  const threadIdsBatch = threadIdsToProcess.slice(0, MAX_THREADS_PER_RUN);

  // Phase 2: fetch full emails (including bodies) only for threads that need processing
  const fullEmails = await db
    .select({
      id: emailsRaw.id,
      gmailThreadId: emailsRaw.gmailThreadId,
      subject: emailsRaw.subject,
      fromEmail: emailsRaw.fromEmail,
      fromName: emailsRaw.fromName,
      date: emailsRaw.date,
      direction: emailsRaw.direction,
      bodyMarkdown: emailsRaw.bodyMarkdown,
      threadState: emailsRaw.threadState,
      threadStateUpdatedAt: emailsRaw.threadStateUpdatedAt,
    })
    .from(emailsRaw)
    .where(
      and(
        eq(emailsRaw.userId, userId),
        inArray(emailsRaw.gmailThreadId, threadIdsBatch),
      ),
    );

  const threadMap = new Map<string, EmailRow[]>();
  for (const email of fullEmails) {
    const list = threadMap.get(email.gmailThreadId) || [];
    list.push(email);
    threadMap.set(email.gmailThreadId, list);
  }

  const threadsToProcess = threadIdsBatch.map((id) => [
    id,
    threadMap.get(id) || [],
  ] as [string, EmailRow[]]);

  const userName = deriveUserName(fullEmails);

  logger.info("Computing thread states", {
    userId,
    totalThreads: threadMeta.size,
    toProcess: threadsToProcess.length,
  });

  const model = await getFastModel();

  const CONCURRENCY = 15;
  const DB_BATCH_SIZE = 20;
  const batch = threadsToProcess;

  const pendingUpdates: { threadId: string; state: string; reason: string }[] =
    [];

  const flushUpdates = async () => {
    if (pendingUpdates.length === 0) return;

    const updateBatch = [...pendingUpdates];
    pendingUpdates.length = 0;

    const valueFragments = updateBatch.map(
      (u) => sql`(${u.threadId}, ${u.state}, ${u.reason})`,
    );

    const valuesList = sql.join(valueFragments, sql`, `);

    try {
      await db.execute(sql`
        UPDATE emails_raw AS e SET
          thread_state = v.state,
          thread_state_reason = v.reason,
          thread_state_updated_at = now(),
          updated_at = now()
        FROM (VALUES ${valuesList})
          AS v(thread_id, state, reason)
        WHERE e.user_id = ${userId}
          AND e.gmail_thread_id = v.thread_id
      `);
    } catch (err) {
      const errStr = String(err);
      logger.error("Batch thread state update failed", {
        userId,
        count: updateBatch.length,
        error: errStr,
      });
      summary.processed -= updateBatch.length;
      summary.errors += updateBatch.length;
      summary.lastError = errStr;
      for (const u of updateBatch) {
        summary.breakdown[u.state] = (summary.breakdown[u.state] || 0) - 1;
      }
    }
  };

  const processThread = async ([threadId, emails]: [string, EmailRow[]]) => {
    try {
      const threadText = reconstructThread(emails);
      const prompt = buildPrompt(threadText, userName);

      const { object } = await generateObject({
        model,
        schema: threadStateSchema,
        prompt,
        maxOutputTokens: 200,
      });

      pendingUpdates.push({
        threadId,
        state: object.state,
        reason: object.reason,
      });

      summary.processed++;
      summary.breakdown[object.state] =
        (summary.breakdown[object.state] || 0) + 1;
    } catch (err) {
      const errStr = String(err);
      logger.error("Thread state computation failed", {
        userId,
        threadId,
        error: errStr,
      });
      summary.errors++;
      summary.lastError = errStr;
    }
  };

  let processedCount = 0;
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    await Promise.all(batch.slice(i, i + CONCURRENCY).map(processThread));
    processedCount += Math.min(CONCURRENCY, batch.length - i);

    if (pendingUpdates.length >= DB_BATCH_SIZE || i + CONCURRENCY >= batch.length) {
      await flushUpdates();
    }

    if (processedCount % 20 === 0 || i + CONCURRENCY >= batch.length) {
      logger.info("Thread triage progress", {
        userId,
        processed: processedCount,
        remaining: batch.length - processedCount,
        total: batch.length,
      });
    }
  }

  await flushUpdates();

  logger.info("Thread state computation completed", { userId, ...summary });
  return summary;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function deriveUserName(emails: EmailRow[]): string {
  const outbound = emails.find(
    (e) => e.direction === "outbound" && e.fromName,
  );
  if (outbound?.fromName) return outbound.fromName;

  const anyOutbound = emails.find((e) => e.direction === "outbound");
  if (anyOutbound) return anyOutbound.fromEmail.split("@")[0];

  return "the user";
}

import { generateText } from "ai";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { emailsRaw } from "../db/schema.js";
import { getFastModel } from "./ai.js";
import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type ThreadState =
  | "resolved"
  | "awaiting_your_reply"
  | "awaiting_their_reply"
  | "fyi"
  | "junk";

export interface ThreadStateSummary {
  threadsProcessed: number;
  breakdown: Record<ThreadState, number>;
}

interface ThreadEmail {
  gmailThreadId: string;
  direction: string;
  date: Date;
  triage: string | null;
  fromEmail: string;
  fromName: string | null;
  toEmails: string[] | null;
  ccEmails: string[] | null;
  subject: string | null;
  bodyMarkdown: string | null;
}

interface ClassificationResult {
  state: ThreadState;
  reason: string;
}

const MAX_BODY_CHARS = 500;
const LLM_CONCURRENCY = 8;

// ── Transcript builder ──────────────────────────────────────────────────────

function buildTranscript(messages: ThreadEmail[]): string {
  return messages
    .map((m) => {
      const dateStr = m.date.toISOString().replace("T", " ").slice(0, 16);
      const from = m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail;
      const to = (m.toEmails ?? []).join(", ") || "unknown";
      const cc = m.ccEmails?.length ? `\nCC: ${m.ccEmails.join(", ")}` : "";
      const subject = m.subject ? `\nSubject: ${m.subject}` : "";
      const body = (m.bodyMarkdown || "").slice(0, MAX_BODY_CHARS);
      return `[${dateStr}] FROM: ${from} TO: ${to}${cc}${subject}\n${body}`;
    })
    .join("\n\n");
}

// ── Derive user email from outbound messages in the thread ──────────────────

function deriveUserEmail(messages: ThreadEmail[]): string | null {
  const outbound = messages.find((m) => m.direction === "outbound");
  return outbound?.fromEmail ?? null;
}

// ── LLM classification for inbound threads ──────────────────────────────────

async function classifyInboundThread(
  messages: ThreadEmail[],
  userEmail: string,
): Promise<ClassificationResult> {
  const transcript = buildTranscript(messages);
  const model = await getFastModel();

  const { text } = await generateText({
    model,
    prompt: `You are triaging an email thread for ${userEmail}.
Given the conversation below, classify the thread state:
- "resolved" — no response needed (thank-you, confirmation, FYI, newsletter, notification)
- "awaiting_your_reply" — ${userEmail} needs to respond to this thread
- "fyi" — ${userEmail} is CC'd or not the primary addressee; no response expected

Respond with ONLY a JSON object: {"state": "resolved"|"awaiting_your_reply"|"fyi", "reason": "one sentence"}

Thread:
${transcript}`,
    maxOutputTokens: 200,
  });

  try {
    const cleaned = text.replace(/```json\s*|```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned) as {
      state: string;
      reason: string;
    };
    const validStates = new Set(["resolved", "awaiting_your_reply", "fyi"]);
    if (!validStates.has(parsed.state)) {
      return { state: "awaiting_your_reply", reason: `LLM returned unknown state "${parsed.state}", defaulting` };
    }
    return {
      state: parsed.state as ThreadState,
      reason: parsed.reason || "",
    };
  } catch {
    logger.warn("Failed to parse LLM classification response", {
      text: text.slice(0, 200),
    });
    return { state: "awaiting_your_reply", reason: "LLM response unparseable, defaulting" };
  }
}

// ── Concurrency limiter ─────────────────────────────────────────────────────

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute thread-level state for all threads belonging to a user.
 *
 * SQL pre-filters (no LLM needed):
 *   - Last message outbound → awaiting_their_reply
 *   - All messages junk → junk
 *
 * For inbound threads, calls Haiku to classify as
 * resolved / awaiting_your_reply / fyi.
 */
export async function computeThreadStates(
  userId: string,
): Promise<ThreadStateSummary> {
  const summary: ThreadStateSummary = {
    threadsProcessed: 0,
    breakdown: {
      resolved: 0,
      awaiting_your_reply: 0,
      awaiting_their_reply: 0,
      fyi: 0,
      junk: 0,
    },
  };

  const rows = await db
    .select({
      gmailThreadId: emailsRaw.gmailThreadId,
      direction: emailsRaw.direction,
      date: emailsRaw.date,
      triage: emailsRaw.triage,
      fromEmail: emailsRaw.fromEmail,
      fromName: emailsRaw.fromName,
      toEmails: emailsRaw.toEmails,
      ccEmails: emailsRaw.ccEmails,
      subject: emailsRaw.subject,
      bodyMarkdown: emailsRaw.bodyMarkdown,
    })
    .from(emailsRaw)
    .where(eq(emailsRaw.userId, userId))
    .orderBy(emailsRaw.gmailThreadId, emailsRaw.date);

  if (rows.length === 0) {
    logger.info("No emails found for thread state computation", { userId });
    return summary;
  }

  // Group by thread
  const threads = new Map<string, ThreadEmail[]>();
  for (const row of rows) {
    const existing = threads.get(row.gmailThreadId);
    if (existing) {
      existing.push(row);
    } else {
      threads.set(row.gmailThreadId, [row]);
    }
  }

  // Classify: SQL pre-filter first, collect inbound threads for LLM
  type ThreadUpdate = { threadId: string; state: ThreadState; reason: string };
  const sqlUpdates: ThreadUpdate[] = [];
  const inboundThreads: { threadId: string; messages: ThreadEmail[] }[] = [];

  for (const [threadId, messages] of threads) {
    summary.threadsProcessed++;
    const last = messages[messages.length - 1];

    const allJunk = messages.every((m) => m.triage === "junk");
    if (allJunk) {
      sqlUpdates.push({ threadId, state: "junk", reason: "all messages triaged as junk" });
      continue;
    }

    if (last.direction === "outbound") {
      sqlUpdates.push({ threadId, state: "awaiting_their_reply", reason: "last message is outbound" });
      continue;
    }

    // Last message is inbound → needs LLM classification
    inboundThreads.push({ threadId, messages });
  }

  // Derive user email from any outbound message across all threads
  let userEmail: string | null = null;
  for (const [, messages] of threads) {
    userEmail = deriveUserEmail(messages);
    if (userEmail) break;
  }
  if (!userEmail) {
    userEmail = "user";
  }

  // Run LLM classification with concurrency limit
  if (inboundThreads.length > 0) {
    logger.info("Classifying inbound threads with LLM", {
      userId,
      count: inboundThreads.length,
    });

    const llmResults = await mapWithConcurrency(
      inboundThreads,
      LLM_CONCURRENCY,
      async ({ threadId, messages }) => {
        try {
          const result = await classifyInboundThread(messages, userEmail!);
          return { threadId, state: result.state, reason: result.reason };
        } catch (err) {
          logger.error("LLM classification failed for thread", {
            threadId,
            error: String(err),
          });
          return {
            threadId,
            state: "awaiting_your_reply" as ThreadState,
            reason: `LLM error: ${String(err).slice(0, 100)}`,
          };
        }
      },
    );

    sqlUpdates.push(...llmResults);
  }

  // Tally breakdown
  for (const { state } of sqlUpdates) {
    summary.breakdown[state]++;
  }

  // Batch UPDATE per state: group by state, then bulk update
  const stateGroups = new Map<ThreadState, string[]>();
  for (const { threadId, state } of sqlUpdates) {
    let group = stateGroups.get(state);
    if (!group) {
      group = [];
      stateGroups.set(state, group);
    }
    group.push(threadId);
  }

  const now = new Date();
  for (const [state, threadIds] of stateGroups) {
    if (threadIds.length === 0) continue;
    const threadIdValues = threadIds.map((id) => sql`${id}`);
    await db.execute(sql`
      UPDATE emails_raw
      SET thread_state = ${state},
          thread_state_reason = NULL,
          thread_state_updated_at = ${now.toISOString()}::timestamptz,
          updated_at = now()
      WHERE user_id = ${userId}
        AND gmail_thread_id IN (${sql.join(threadIdValues, sql`, `)})
    `);
  }

  // Write per-thread reasons (via VALUES join for efficiency)
  const allReasonUpdates = sqlUpdates.filter((u) => u.reason);
  if (allReasonUpdates.length > 0) {
    const valueRows = allReasonUpdates.map(
      (u) => sql`(${u.threadId}, ${u.reason})`,
    );
    await db.execute(sql`
      UPDATE emails_raw SET
        thread_state_reason = v.reason
      FROM (VALUES ${sql.join(valueRows, sql`, `)}) AS v(thread_id, reason)
      WHERE emails_raw.user_id = ${userId}
        AND emails_raw.gmail_thread_id = v.thread_id
    `);
  }

  logger.info("Thread state computation completed", {
    userId,
    ...summary,
    llmClassified: inboundThreads.length,
  });

  return summary;
}

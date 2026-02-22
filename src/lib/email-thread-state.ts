import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { emailsRaw } from "../db/schema.js";
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

interface ThreadMessage {
  gmailThreadId: string;
  direction: string;
  date: Date;
  triage: string | null;
}

// ── Core Logic ──────────────────────────────────────────────────────────────

function computeStateForThread(messages: ThreadMessage[]): ThreadState {
  if (messages.length === 0) return "junk";

  const allJunk = messages.every((m) => m.triage === "junk");
  if (allJunk) return "junk";

  const allJunkOrFyi = messages.every(
    (m) => m.triage === "junk" || m.triage === "fyi",
  );
  if (allJunkOrFyi) return "fyi";

  const last = messages[messages.length - 1];

  if (last.direction === "outbound") {
    return "awaiting_their_reply";
  }

  // Last message is inbound
  if (last.triage === "fyi" || last.triage === "junk") {
    return "fyi";
  }

  return "awaiting_your_reply";
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute thread-level state for all threads belonging to a user,
 * then denormalize the state onto every row in each thread.
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
    })
    .from(emailsRaw)
    .where(eq(emailsRaw.userId, userId))
    .orderBy(emailsRaw.gmailThreadId, emailsRaw.date);

  if (rows.length === 0) {
    logger.info("No emails found for thread state computation", { userId });
    return summary;
  }

  // Group by thread
  const threads = new Map<string, ThreadMessage[]>();
  for (const row of rows) {
    const existing = threads.get(row.gmailThreadId);
    if (existing) {
      existing.push(row);
    } else {
      threads.set(row.gmailThreadId, [row]);
    }
  }

  // Compute state per thread and batch the updates
  const stateMap = new Map<ThreadState, string[]>();
  for (const [threadId, messages] of threads) {
    const state = computeStateForThread(messages);
    summary.threadsProcessed++;
    summary.breakdown[state]++;

    const existing = stateMap.get(state);
    if (existing) {
      existing.push(threadId);
    } else {
      stateMap.set(state, [threadId]);
    }
  }

  // Batch UPDATE per state value to minimise round-trips
  const now = new Date();
  for (const [state, threadIds] of stateMap) {
    if (threadIds.length === 0) continue;

    const threadIdValues = threadIds.map((id) => sql`${id}`);
    await db.execute(sql`
      UPDATE emails_raw
      SET thread_state = ${state},
          thread_state_updated_at = ${now.toISOString()}::timestamptz,
          updated_at = now()
      WHERE user_id = ${userId}
        AND gmail_thread_id IN (${sql.join(threadIdValues, sql`, `)})
    `);
  }

  logger.info("Thread state computation completed", {
    userId,
    ...summary,
  });

  return summary;
}

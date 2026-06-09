import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { pool } from "../lib/pool.js";
import { createProgress } from "../lib/progress.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
const dryRun = process.argv.includes("--dry-run");
const envFile = isProd ? ".env.production" : ".env.local";
config({ path: resolve(repoRoot, envFile) });
if (isProd) console.log("Using .env.production (--prod)");
if (dryRun) console.log("DRY RUN — will not create/update/delete any memories");

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const threadLimit = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;

const concurrencyArg = process.argv.find((a) => a.startsWith("--concurrency="));
const concurrency = concurrencyArg ? parseInt(concurrencyArg.split("=")[1], 10) : 3;

const { db } = await import("../db/client.js");
const { extractMemories } = await import("../memory/extract.js");
const { ensureSlackUserEntityLink } = await import("../users/entity-link.js");

type ResultRow = Record<string, unknown>;
function extractRows(result: unknown): ResultRow[] {
  return ((result as any).rows ?? result) as ResultRow[];
}

// ── Find all threads ────────────────────────────────────────────────────────

interface ThreadInfo {
  channelId: string;
  threadTs: string;
  channelType: string;
  lastUserMessage: string;
  lastUserMessageId: string;
  lastUserId: string;
  messageCount: number;
  firstMessageAt: Date;
  lastMessageAt: Date;
}

interface SlackUserRow {
  id: string;
  workspace_id: string;
  slack_user_id: string;
  display_name: string;
}

async function discoverThreads(): Promise<ThreadInfo[]> {
  const rows = extractRows(
    await db.execute(sql`
      SELECT
        tk.channel_id,
        tk.thread_ts,
        tk.channel_type,
        tk.msg_count,
        tk.first_msg_at,
        tk.last_msg_at,
        last_msg.id AS last_user_message_id,
        last_msg.content AS last_user_message,
        last_msg.user_id AS last_user_id
      FROM (
        SELECT
          channel_id,
          COALESCE(slack_thread_ts, slack_ts) AS thread_ts,
          channel_type,
          COUNT(*) AS msg_count,
          MIN(created_at) AS first_msg_at,
          MAX(created_at) AS last_msg_at
        FROM messages
        WHERE role IN ('user', 'assistant')
        GROUP BY channel_id, COALESCE(slack_thread_ts, slack_ts), channel_type
        HAVING COUNT(*) >= 2
      ) tk
      CROSS JOIN LATERAL (
        SELECT id, content, user_id
        FROM messages
        WHERE channel_id = tk.channel_id
          AND COALESCE(slack_thread_ts, slack_ts) = tk.thread_ts
          AND role = 'user'
        ORDER BY created_at DESC
        LIMIT 1
      ) last_msg
      -- Chronological by last activity: a thread's knowledge is as fresh as its
      -- newest message, so later-active threads must be ingested later for
      -- supersession to point the right way.
      ORDER BY tk.last_msg_at ASC
    `),
  );

  return rows.map((r) => ({
    channelId: r.channel_id as string,
    threadTs: r.thread_ts as string,
    channelType: r.channel_type as string,
    lastUserMessage: r.last_user_message as string,
    lastUserMessageId: r.last_user_message_id as string,
    lastUserId: r.last_user_id as string,
    messageCount: Number(r.msg_count),
    firstMessageAt: new Date(r.first_msg_at as string),
    lastMessageAt: new Date(r.last_msg_at as string),
  }));
}

// ── Process a single thread ─────────────────────────────────────────────────

let errors = 0;

async function processThread(
  thread: ThreadInfo,
  progress: ReturnType<typeof createProgress>,
): Promise<void> {
  try {
    if (dryRun) {
      progress.tick();
      return;
    }

    await extractMemories({
      userMessage: thread.lastUserMessage,
      assistantResponse: "",
      userId: thread.lastUserId,
      channelType: thread.channelType as any,
      channelId: thread.channelId,
      threadTs: thread.threadTs,
      sourceMessageId: thread.lastUserMessageId,
      createdAt: thread.firstMessageAt,
    });

    progress.tick();
  } catch (err) {
    errors++;
    progress.tick();
    console.error(
      `  ERROR on thread ${thread.channelId}/${thread.threadTs}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Memory Backfill Script (Thread-Scoped Reconciliation) ===\n");

  if (dryRun) {
    console.log("Skipping entity link pass (dry run)");
  } else {
    console.log("Ensuring person entities exist for Slack users...");
    const slackUsers = extractRows(
      await db.execute(sql`
        SELECT id, workspace_id, slack_user_id, display_name
        FROM users
        WHERE slack_user_id IS NOT NULL
        ORDER BY created_at ASC
      `),
    ).map((row) => ({
      id: String(row.id),
      workspace_id: String(row.workspace_id),
      slack_user_id: String(row.slack_user_id),
      display_name: String(row.display_name),
    })) as SlackUserRow[];

    let ensuredUserEntityLinks = 0;
    let failedUserEntityLinks = 0;
    for (const user of slackUsers) {
      try {
        const linked = await ensureSlackUserEntityLink({
          userId: user.id,
          slackUserId: user.slack_user_id,
          displayName: user.display_name,
          workspaceId: user.workspace_id,
        });
        if (linked) ensuredUserEntityLinks++;
      } catch (error) {
        failedUserEntityLinks++;
        console.error(
          `  ERROR ensuring entity for user ${user.slack_user_id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    console.log(
      `Ensured links for ${ensuredUserEntityLinks}/${slackUsers.length} Slack users` +
        (failedUserEntityLinks > 0 ? ` (${failedUserEntityLinks} failures)` : ""),
    );
  }

  const allThreads = await discoverThreads();
  console.log(`Found ${allThreads.length} threads with >= 2 user/assistant messages`);
  if (allThreads.length > 0) {
    const first = allThreads[0];
    const last = allThreads[allThreads.length - 1];
    console.log(
      `Processing chronologically (by last activity): ` +
        `${first.lastMessageAt.toISOString()} -> ${last.lastMessageAt.toISOString()}`,
    );
  }

  const threads = threadLimit < Infinity ? allThreads.slice(0, threadLimit) : allThreads;
  if (threadLimit < Infinity) {
    console.log(`Processing first ${threads.length} threads (--limit=${threadLimit})`);
  }

  if (threads.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  console.log(`Concurrency: ${concurrency}\n`);

  const progress = createProgress(threads.length, { label: "threads", logEvery: 5 });

  await pool(threads, concurrency, async (thread) => {
    await processThread(thread, progress);
  });

  // Fix entity timestamps: set created_at to earliest linked memory, updated_at to latest
  if (!dryRun) {
    console.log("\nFixing entity timestamps from linked memories...");
    const fixResult = await db.execute(sql`
    UPDATE entities e
    SET
      created_at = sub.first_memory_at,
      updated_at = sub.last_memory_at
    FROM (
      SELECT
        me.entity_id,
        MIN(m.created_at) AS first_memory_at,
        MAX(m.created_at) AS last_memory_at
      FROM memory_entities me
      JOIN memories m ON m.id = me.memory_id
      GROUP BY me.entity_id
    ) sub
      WHERE e.id = sub.entity_id
    `);
    const fixedCount = (fixResult as any).rowCount ?? "?";
    console.log(`Updated timestamps for ${fixedCount} entities`);
  }

  console.log(`\n=== Summary ===`);
  progress.done();
  console.log(`Errors: ${errors}`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

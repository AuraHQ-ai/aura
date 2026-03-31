import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { pool } from "../lib/pool.js";

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

const { db } = await import("../db/client.js");
const { extractMemories } = await import("../memory/extract.js");

type ResultRow = Record<string, unknown>;
function extractRows(result: unknown): ResultRow[] {
  return ((result as any).rows ?? result) as ResultRow[];
}

// ── Config ──────────────────────────────────────────────────────────────────

const CONCURRENCY = 3;

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
        last_msg.id AS last_user_message_id,
        last_msg.content AS last_user_message,
        last_msg.user_id AS last_user_id
      FROM (
        SELECT
          channel_id,
          COALESCE(slack_thread_ts, slack_ts) AS thread_ts,
          channel_type,
          COUNT(*) AS msg_count,
          MIN(created_at) AS first_msg_at
        FROM messages
        WHERE role IN ('user', 'assistant')
        GROUP BY channel_id, COALESCE(slack_thread_ts, slack_ts), channel_type
        HAVING COUNT(*) >= 2
        ORDER BY MAX(created_at) DESC
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
  }));
}

// ── Process a single thread ─────────────────────────────────────────────────

let processed = 0;
let errors = 0;

async function processThread(
  thread: ThreadInfo,
  idx: number,
  total: number,
): Promise<void> {
  try {
    if (dryRun) {
      console.log(
        `[${idx + 1}/${total}] DRY RUN: thread ${thread.channelId}/${thread.threadTs} ` +
          `(${thread.messageCount} msgs, last user: "${thread.lastUserMessage.slice(0, 80)}...")`,
      );
      processed++;
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

    processed++;
    if (processed % 10 === 0 || idx === total - 1) {
      console.log(`[${idx + 1}/${total}] Processed ${processed} threads (${errors} errors)`);
    }
  } catch (err) {
    errors++;
    console.error(
      `[${idx + 1}/${total}] ERROR on thread ${thread.channelId}/${thread.threadTs}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Memory Backfill Script (Thread-Scoped Reconciliation) ===\n");

  const allThreads = await discoverThreads();
  console.log(`Found ${allThreads.length} threads with >= 2 user/assistant messages`);

  const threads = threadLimit < Infinity ? allThreads.slice(0, threadLimit) : allThreads;
  if (threadLimit < Infinity) {
    console.log(`Processing first ${threads.length} threads (--limit=${threadLimit})`);
  }

  if (threads.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  console.log(`Concurrency: ${CONCURRENCY}\n`);

  const startTime = Date.now();

  const indexed = threads.map((t, i) => ({ thread: t, idx: i }));
  await pool(indexed, CONCURRENCY, async ({ thread, idx }) => {
    await processThread(thread, idx, threads.length);
  });

  // Fix entity timestamps: set created_at to earliest linked memory, updated_at to latest
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

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Summary ===`);
  console.log(`Elapsed: ${elapsed}s`);
  console.log(`Threads processed: ${processed}`);
  console.log(`Errors: ${errors}`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

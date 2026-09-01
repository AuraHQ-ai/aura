/**
 * Memory rebuild/replay script (#1041).
 *
 * Replays stored `messages` threads through the CURRENT memory extractor for a
 * scoped selection, so extractor changes can be validated against real data
 * before (or instead of) touching the live store.
 *
 * Usage (from apps/api):
 *   pnpm rebuild:memories --user=U0123ABC                        # dry run (default)
 *   pnpm rebuild:memories --channel=C0123ABC --since=2026-06-01
 *   pnpm rebuild:memories --user=U0123ABC --apply --confirm=REBUILD
 *
 * Or from the repo root: pnpm rebuild:memories -- --user=U0123ABC
 *
 * Flags:
 *   --user=<id> --channel=<id> --since=<date> --until=<date>   scope (REQUIRED, at least one)
 *   --dry-run              default — replays into an isolated `rebuild-*` sandbox
 *                          workspace and writes JSON artifacts; live memories untouched
 *   --apply                mutate the live memories table (archive scoped memories,
 *                          then re-extract). Requires --confirm=REBUILD.
 *   --confirm=REBUILD      hard confirmation for --apply
 *   --max-threads=N        per-run cap (default 100). The run ABORTS if the scope
 *                          matches more threads — narrow the scope or raise the cap.
 *   --concurrency=N        parallel extractions, 1-10 (default 2) — rate-limits LLM spend
 *   --model=<gateway-id>   pin the extraction model
 *   --workspace=<id>       tenant workspace (default "default")
 *   --out=<dir>            artifacts directory (default ./memory-snapshots/<runId>/)
 *   --keep-sandbox         dry run: keep sandbox rows in the DB for inspection
 *   --prod                 use .env.production instead of .env.local
 *
 * Safety rails (the point of #1041):
 *   - scope is mandatory: no accidental full-corpus runs
 *   - dry run is the default; --apply needs an explicit confirmation token
 *   - hard per-run thread cap: a runaway rebuild aborts before extracting
 *   - --apply never hard-deletes: existing memories are ARCHIVED (status flip,
 *     reversible via the rollback artifact); new memories are plain inserts
 *   - every run snapshots the scoped live memories to before.json first
 */

import { config } from "dotenv";
import { resolve, join } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, writeFileSync } from "fs";
import {
  parseRebuildArgs,
  describeScope,
  diffSnapshots,
  computeAppliedChanges,
  formatDiffSummary,
  REBUILD_WORKSPACE_PREFIX,
  type RebuildArgs,
  type MemorySnapshotRow,
  type MemoryFingerprint,
} from "./rebuild-memories-lib.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");

const parsed = parseRebuildArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`ERROR: ${parsed.error}`);
  process.exit(1);
}
const args: RebuildArgs = parsed.args;

const envFile = args.prod ? ".env.production" : ".env.local";
config({ path: resolve(repoRoot, envFile) });
if (args.prod) console.log("Using .env.production (--prod)");

const { db } = await import("../db/client.js");
const { sql } = await import("drizzle-orm");
const { extractMemories } = await import("../memory/extract.js");
const { pool } = await import("../lib/pool.js");
const { createProgress } = await import("../lib/progress.js");

type ResultRow = Record<string, unknown>;
function extractRows(result: unknown): ResultRow[] {
  return ((result as any).rows ?? result) as ResultRow[];
}

// ── Scope filters ────────────────────────────────────────────────────────────

const userFilter = args.scope.user
  ? sql`AND ${args.scope.user} = ANY(related_user_ids)`
  : sql``;
const channelMemoryFilter = args.scope.channel
  ? sql`AND source_channel_id = ${args.scope.channel}`
  : sql``;
const sinceMemoryFilter = args.scope.since
  ? sql`AND created_at >= ${args.scope.since}::date`
  : sql``;
const untilMemoryFilter = args.scope.until
  ? sql`AND created_at < (${args.scope.until}::date + 1)`
  : sql``;

// ── Thread discovery ─────────────────────────────────────────────────────────

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

async function discoverScopedThreads(): Promise<ThreadInfo[]> {
  const channelFilter = args.scope.channel
    ? sql`AND channel_id = ${args.scope.channel}`
    : sql``;
  const userHaving = args.scope.user
    ? sql`AND BOOL_OR(role = 'user' AND user_id = ${args.scope.user})`
    : sql``;
  const sinceFilter = args.scope.since
    ? sql`AND tk.last_msg_at >= ${args.scope.since}::date`
    : sql``;
  const untilFilter = args.scope.until
    ? sql`AND tk.last_msg_at < (${args.scope.until}::date + 1)`
    : sql``;

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
          AND workspace_id = ${args.workspaceId}
          ${channelFilter}
        GROUP BY channel_id, COALESCE(slack_thread_ts, slack_ts), channel_type
        HAVING COUNT(*) >= 2 ${userHaving}
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
      WHERE TRUE ${sinceFilter} ${untilFilter}
      -- Chronological by last activity so supersession points the right way.
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

// ── Snapshots ────────────────────────────────────────────────────────────────

function mapSnapshotRow(r: ResultRow): MemorySnapshotRow & { updatedAt: string } {
  return {
    id: r.id as string,
    content: r.content as string,
    type: r.type as string,
    status: r.status as string,
    importance: r.importance == null ? null : Number(r.importance),
    relatedUserIds: (r.related_user_ids ?? []) as string[],
    sourceChannelId: (r.source_channel_id ?? null) as string | null,
    sourceThreadTs: (r.source_thread_ts ?? null) as string | null,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

/** Live memories matching the scope (status current/disputed). */
async function snapshotScopedMemories(): Promise<MemorySnapshotRow[]> {
  const rows = extractRows(
    await db.execute(sql`
      SELECT id, content, type, status, importance, related_user_ids,
             source_channel_id, source_thread_ts, created_at, updated_at
      FROM memories
      WHERE workspace_id = ${args.workspaceId}
        AND status IN ('current', 'disputed')
        ${userFilter} ${channelMemoryFilter} ${sinceMemoryFilter} ${untilMemoryFilter}
      ORDER BY created_at ASC
    `),
  );
  return rows.map(mapSnapshotRow);
}

/**
 * Full-workspace fingerprint (id + status + content hash) used to detect what
 * an --apply run touched. Timestamps are useless for this: replayed memories
 * carry historical thread timestamps, not wall-clock write time.
 */
async function fingerprintWorkspace(workspaceId: string): Promise<MemoryFingerprint[]> {
  const rows = extractRows(
    await db.execute(sql`
      SELECT id, status, md5(content) AS content_hash
      FROM memories
      WHERE workspace_id = ${workspaceId}
    `),
  );
  return rows.map((r) => ({
    id: r.id as string,
    status: r.status as string,
    contentHash: r.content_hash as string,
  }));
}

/** Everything the rebuild produced in the sandbox workspace. */
async function snapshotWorkspaceMemories(workspaceId: string): Promise<MemorySnapshotRow[]> {
  const rows = extractRows(
    await db.execute(sql`
      SELECT id, content, type, status, importance, related_user_ids,
             source_channel_id, source_thread_ts, created_at, updated_at
      FROM memories
      WHERE workspace_id = ${workspaceId}
        AND status IN ('current', 'disputed')
      ORDER BY created_at ASC
    `),
  );
  return rows.map(mapSnapshotRow);
}

// ── Sandbox workspace lifecycle (dry run) ────────────────────────────────────

async function createSandboxWorkspace(runId: string): Promise<string> {
  const id = `${REBUILD_WORKSPACE_PREFIX}${runId}`;
  await db.execute(sql`
    INSERT INTO workspaces (id, name, plan)
    VALUES (${id}, ${`Memory Rebuild Sandbox ${runId}`}, 'internal')
    ON CONFLICT (id) DO NOTHING
  `);
  return id;
}

async function wipeSandboxWorkspace(workspaceId: string): Promise<void> {
  if (!workspaceId.startsWith(REBUILD_WORKSPACE_PREFIX)) {
    throw new Error(`Refusing to wipe non-sandbox workspace "${workspaceId}"`);
  }
  // Junctions first, then parents. Only rows this run created live here.
  await db.execute(sql`
    DELETE FROM memory_entities
    WHERE memory_id IN (SELECT id FROM memories WHERE workspace_id = ${workspaceId})
  `);
  await db.execute(sql`
    DELETE FROM entity_aliases
    WHERE entity_id IN (SELECT id FROM entities WHERE workspace_id = ${workspaceId})
  `);
  await db.execute(sql`DELETE FROM memories WHERE workspace_id = ${workspaceId}`);
  await db.execute(sql`DELETE FROM entities WHERE workspace_id = ${workspaceId}`);
  await db.execute(sql`DELETE FROM workspaces WHERE id = ${workspaceId}`);
}

// ── Replay ───────────────────────────────────────────────────────────────────

const usageByModel = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>();
function recordUsage(
  modelId: string,
  usage: { inputTokens?: number; outputTokens?: number },
): void {
  const entry = usageByModel.get(modelId) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
  entry.calls++;
  entry.inputTokens += usage.inputTokens ?? 0;
  entry.outputTokens += usage.outputTokens ?? 0;
  usageByModel.set(modelId, entry);
}

let errors = 0;

async function replayThreads(threads: ThreadInfo[], targetWorkspaceId: string): Promise<void> {
  const progress = createProgress(threads.length, { label: "threads", logEvery: 5 });
  await pool(threads, args.concurrency, async (thread) => {
    try {
      await extractMemories({
        userMessage: thread.lastUserMessage,
        assistantResponse: "",
        userId: thread.lastUserId,
        channelType: thread.channelType as any,
        channelId: thread.channelId,
        threadTs: thread.threadTs,
        sourceMessageId: thread.lastUserMessageId,
        createdAt: thread.firstMessageAt,
        workspaceId: targetWorkspaceId,
        extractionModelId: args.model,
        onUsage: recordUsage,
      });
    } catch (err) {
      errors++;
      console.error(
        `  ERROR on thread ${thread.channelId}/${thread.threadTs}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    progress.tick();
  });
  progress.done();
}

// ── Artifacts ────────────────────────────────────────────────────────────────

function writeArtifact(dir: string, name: string, data: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(data, null, 2) + "\n");
}

function printUsage(): void {
  if (usageByModel.size === 0) return;
  console.log("\nLLM usage:");
  for (const [modelId, u] of usageByModel) {
    console.log(`  ${modelId}: ${u.calls} calls, ${u.inputTokens} in / ${u.outputTokens} out tokens`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const mode = args.apply ? "APPLY" : "DRY RUN";
  const runStart = new Date();
  const runId = `${args.apply ? "apply" : "dry"}-${runStart.toISOString().replace(/[:.]/g, "-")}`;
  const outDir = args.outDir ?? join(repoRoot, "memory-snapshots", runId);
  mkdirSync(outDir, { recursive: true });

  console.log(`=== Memory Rebuild (${mode}) ===`);
  console.log(`Scope:      ${describeScope(args.scope)}`);
  console.log(`Workspace:  ${args.workspaceId}`);
  console.log(`Artifacts:  ${outDir}\n`);

  const threads = await discoverScopedThreads();
  console.log(`Scope matches ${threads.length} thread(s) with >= 2 user/assistant messages`);

  if (threads.length === 0) {
    console.log("Nothing to replay — exiting.");
    return;
  }
  if (threads.length > args.maxThreads) {
    console.error(
      `\nABORT: scope matches ${threads.length} threads, which exceeds the per-run cap of ` +
        `${args.maxThreads}. Narrow the scope (--user / --channel / --since / --until) or ` +
        `raise --max-threads explicitly. Nothing was extracted or modified.`,
    );
    process.exit(2);
  }

  // 1. Snapshot current live state — always, both modes.
  const before = await snapshotScopedMemories();
  writeArtifact(outDir, "before.json", before);
  console.log(`Snapshotted ${before.length} scoped live memories -> before.json`);

  if (!args.apply) {
    // ── Dry run: replay into an isolated sandbox workspace ──────────────────
    const sandboxId = await createSandboxWorkspace(runId);
    console.log(`Sandbox workspace: ${sandboxId}`);
    console.log(`Replaying ${threads.length} threads (concurrency ${args.concurrency})...\n`);

    try {
      await replayThreads(threads, sandboxId);

      const after = await snapshotWorkspaceMemories(sandboxId);
      writeArtifact(outDir, "after.json", after);

      const diff = diffSnapshots(before, after);
      writeArtifact(outDir, "diff.json", diff);

      console.log(`\n=== Dry-run diff (live vs rebuilt) ===`);
      console.log(formatDiffSummary(diff));
    } finally {
      if (args.keepSandbox) {
        console.log(
          `\nSandbox kept (--keep-sandbox). Inspect with workspace_id='${sandboxId}', ` +
            `then purge via: DELETE FROM memories WHERE workspace_id = '${sandboxId}'; (etc.)`,
        );
      } else {
        await wipeSandboxWorkspace(sandboxId);
        console.log(`\nSandbox workspace ${sandboxId} wiped.`);
      }
    }
  } else {
    // ── Apply: archive scoped live memories, then re-extract into live ──────
    const fingerprintBefore = await fingerprintWorkspace(args.workspaceId);

    console.log(`\nArchiving ${before.length} scoped live memories (soft, reversible)...`);
    const archivedRows = extractRows(
      await db.execute(sql`
        UPDATE memories
        SET status = 'archived', updated_at = ${runStart}
        WHERE workspace_id = ${args.workspaceId}
          AND status IN ('current', 'disputed')
          ${userFilter} ${channelMemoryFilter} ${sinceMemoryFilter} ${untilMemoryFilter}
        RETURNING id
      `),
    );
    const archivedIds = new Set(archivedRows.map((r) => r.id as string));
    const rollback = {
      note:
        "To reverse this run: restore each archived memory to its prior status, and " +
        "archive the memories listed in diff.json under applied.addedIds. No rows were deleted.",
      restoreArchived: before
        .filter((m) => archivedIds.has(m.id))
        .map((m) => ({ id: m.id, priorStatus: m.status })),
    };
    writeArtifact(outDir, "rollback.json", rollback);
    console.log(`Archived ${archivedIds.size} memories -> rollback.json`);

    console.log(`Replaying ${threads.length} threads (concurrency ${args.concurrency})...\n`);
    await replayThreads(threads, args.workspaceId);

    // Everything the run touched, detected by full-workspace fingerprint diff
    // (covers reconciliation side-effects on memories OUTSIDE the scope too).
    const fingerprintAfter = await fingerprintWorkspace(args.workspaceId);
    const changes = computeAppliedChanges(fingerprintBefore, fingerprintAfter);

    const after = await snapshotScopedMemories();
    writeArtifact(outDir, "after.json", after);
    writeArtifact(outDir, "diff.json", { ...diffSnapshots(before, after), applied: changes });

    console.log(`\n=== Apply summary ===`);
    console.log(`Memories added:   ${changes.addedIds.length}`);
    console.log(`Memories updated: ${changes.updatedIds.length}`);
    console.log(`Memories deleted: ${changes.deletedIds.length} (soft — archived/superseded, see rollback.json)`);
  }

  writeArtifact(outDir, "run.json", {
    runId,
    mode,
    scope: args.scope,
    workspaceId: args.workspaceId,
    threadsMatched: threads.length,
    maxThreads: args.maxThreads,
    concurrency: args.concurrency,
    model: args.model ?? "default (fast model)",
    errors,
    startedAt: runStart.toISOString(),
    finishedAt: new Date().toISOString(),
    usage: Object.fromEntries(usageByModel),
  });

  printUsage();
  console.log(`\nErrors: ${errors}`);
  console.log(`Artifacts written to ${outDir}`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

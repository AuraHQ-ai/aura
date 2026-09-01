/**
 * Pure helpers for the memory rebuild/replay script (#1041).
 *
 * Everything in this module is side-effect free (no dotenv, no DB, no LLM)
 * so the safety-rail logic — scope validation, apply confirmation, per-run
 * caps, diff computation — is unit-testable in isolation. The I/O lives in
 * `rebuild-memories.ts`.
 */

// ── Args ─────────────────────────────────────────────────────────────────────

export const APPLY_CONFIRMATION_TOKEN = "REBUILD";
export const DEFAULT_MAX_THREADS = 100;
export const DEFAULT_CONCURRENCY = 2;
export const REBUILD_WORKSPACE_PREFIX = "rebuild-";

export interface RebuildScope {
  /** Slack user ID — replay only threads this user participated in. */
  user?: string;
  /** Slack channel ID — replay only threads in this channel. */
  channel?: string;
  /** Inclusive ISO date (YYYY-MM-DD) lower bound on thread activity. */
  since?: string;
  /** Inclusive ISO date (YYYY-MM-DD) upper bound on thread activity. */
  until?: string;
}

export interface RebuildArgs {
  scope: RebuildScope;
  /** false = dry run (default). true = mutate the live memories table. */
  apply: boolean;
  /** Hard cap on threads processed in a single run. */
  maxThreads: number;
  /** Parallel extraction workers (rate-limits LLM/embedding spend). */
  concurrency: number;
  /** Pin the extraction model (defaults to the catalog fast model). */
  model?: string;
  /** Target workspace (tenant). Defaults to "default". */
  workspaceId: string;
  /** Output directory override for run artifacts. */
  outDir?: string;
  /** Dry run only: keep the sandbox workspace rows for inspection. */
  keepSandbox: boolean;
  /** Load .env.production instead of .env.local. */
  prod: boolean;
}

export type ParseResult =
  | { ok: true; args: RebuildArgs }
  | { ok: false; error: string };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLACK_USER_RE = /^[UW][A-Z0-9]+$/;
const SLACK_CHANNEL_RE = /^[CDG][A-Z0-9]+$/;

function flagValue(argv: string[], name: string): string | undefined {
  const arg = argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.slice(name.length + 3);
}

/**
 * Parse and validate CLI arguments.
 *
 * Safety rails enforced here:
 * - A scope (--user / --channel / --since / --until) is REQUIRED. There is no
 *   way to run against the full corpus by omission.
 * - --apply additionally requires --confirm=REBUILD.
 * - --apply and --dry-run are mutually exclusive (dry run is the default).
 * - --max-threads must be a positive integer — the cap is always finite.
 */
export function parseRebuildArgs(argv: string[]): ParseResult {
  const fail = (error: string): ParseResult => ({ ok: false, error });

  const user = flagValue(argv, "user");
  const channel = flagValue(argv, "channel");
  const since = flagValue(argv, "since");
  const until = flagValue(argv, "until");

  if (!user && !channel && !since && !until) {
    return fail(
      "A scope is required: pass --user=<slack_user_id>, --channel=<channel_id>, " +
        "and/or a date range (--since=YYYY-MM-DD / --until=YYYY-MM-DD). " +
        "Full-corpus rebuilds are intentionally not supported.",
    );
  }

  if (user && !SLACK_USER_RE.test(user)) {
    return fail(`--user must be a Slack user ID (e.g. U0123ABC), got "${user}"`);
  }
  if (channel && !SLACK_CHANNEL_RE.test(channel)) {
    return fail(`--channel must be a Slack channel ID (e.g. C0123ABC), got "${channel}"`);
  }
  for (const [name, value] of [["since", since], ["until", until]] as const) {
    if (value && !ISO_DATE_RE.test(value)) {
      return fail(`--${name} must be an ISO date (YYYY-MM-DD), got "${value}"`);
    }
  }
  if (since && until && since > until) {
    return fail(`--since (${since}) must not be after --until (${until})`);
  }

  const apply = argv.includes("--apply");
  const dryRunFlag = argv.includes("--dry-run");
  if (apply && dryRunFlag) {
    return fail("--apply and --dry-run are mutually exclusive");
  }
  if (apply) {
    const confirm = flagValue(argv, "confirm");
    if (confirm !== APPLY_CONFIRMATION_TOKEN) {
      return fail(
        `--apply mutates the live memories table and requires --confirm=${APPLY_CONFIRMATION_TOKEN}. ` +
          "Run without --apply first and review the dry-run diff.",
      );
    }
  }

  const maxThreadsRaw = flagValue(argv, "max-threads");
  const maxThreads = maxThreadsRaw ? Number(maxThreadsRaw) : DEFAULT_MAX_THREADS;
  if (!Number.isInteger(maxThreads) || maxThreads <= 0) {
    return fail(`--max-threads must be a positive integer, got "${maxThreadsRaw}"`);
  }

  const concurrencyRaw = flagValue(argv, "concurrency");
  const concurrency = concurrencyRaw ? Number(concurrencyRaw) : DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency <= 0 || concurrency > 10) {
    return fail(`--concurrency must be an integer between 1 and 10, got "${concurrencyRaw}"`);
  }

  const workspaceId = flagValue(argv, "workspace") ?? "default";
  if (workspaceId.startsWith(REBUILD_WORKSPACE_PREFIX) || workspaceId.startsWith("bench-")) {
    return fail(`--workspace must be a real tenant workspace, got "${workspaceId}"`);
  }

  return {
    ok: true,
    args: {
      scope: { user, channel, since, until },
      apply,
      maxThreads,
      concurrency,
      model: flagValue(argv, "model"),
      workspaceId,
      outDir: flagValue(argv, "out"),
      keepSandbox: argv.includes("--keep-sandbox"),
      prod: argv.includes("--prod"),
    },
  };
}

/** Human-readable one-liner describing the scope (for logs and artifacts). */
export function describeScope(scope: RebuildScope): string {
  const parts: string[] = [];
  if (scope.user) parts.push(`user=${scope.user}`);
  if (scope.channel) parts.push(`channel=${scope.channel}`);
  if (scope.since) parts.push(`since=${scope.since}`);
  if (scope.until) parts.push(`until=${scope.until}`);
  return parts.join(" ");
}

// ── Diff ─────────────────────────────────────────────────────────────────────

export interface MemorySnapshotRow {
  id: string;
  content: string;
  type: string;
  status: string;
  importance: number | null;
  relatedUserIds: string[];
  sourceChannelId: string | null;
  sourceThreadTs: string | null;
  createdAt: string;
}

export interface SnapshotDiff {
  /** Memories present after the rebuild but not before (by normalized content). */
  added: MemorySnapshotRow[];
  /** Memories present before but not reproduced by the rebuild. */
  removed: MemorySnapshotRow[];
  /** Count of memories whose normalized content survived unchanged. */
  unchanged: number;
  typeDistributionBefore: Record<string, number>;
  typeDistributionAfter: Record<string, number>;
}

function normalizeContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

function typeDistribution(rows: MemorySnapshotRow[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const row of rows) dist[row.type] = (dist[row.type] ?? 0) + 1;
  return dist;
}

/**
 * Content-level diff between two memory snapshots. Matching is by normalized
 * content (case/whitespace-insensitive) since a rebuild produces new row IDs.
 */
export function diffSnapshots(
  before: MemorySnapshotRow[],
  after: MemorySnapshotRow[],
): SnapshotDiff {
  const beforeByContent = new Map<string, MemorySnapshotRow>();
  for (const row of before) beforeByContent.set(normalizeContent(row.content), row);
  const afterByContent = new Map<string, MemorySnapshotRow>();
  for (const row of after) afterByContent.set(normalizeContent(row.content), row);

  const added = [...afterByContent.entries()]
    .filter(([key]) => !beforeByContent.has(key))
    .map(([, row]) => row);
  const removed = [...beforeByContent.entries()]
    .filter(([key]) => !afterByContent.has(key))
    .map(([, row]) => row);
  const unchanged = [...beforeByContent.keys()].filter((key) => afterByContent.has(key)).length;

  return {
    added,
    removed,
    unchanged,
    typeDistributionBefore: typeDistribution(before),
    typeDistributionAfter: typeDistribution(after),
  };
}

/** Minimal per-row fingerprint used to detect what an --apply run touched. */
export interface MemoryFingerprint {
  id: string;
  status: string;
  contentHash: string;
}

/** Classification of live rows touched by an --apply run. */
export interface AppliedChanges {
  addedIds: string[];
  updatedIds: string[];
  deletedIds: string[];
}

const LIVE_STATUSES = new Set(["current", "disputed"]);

/**
 * Diff two full-workspace fingerprint sets taken before/after an apply run.
 *
 * Timestamps are deliberately NOT used: replayed memories are stamped with
 * historical thread timestamps (the extractor's `createdAt` override), so
 * created_at/updated_at say nothing about when a row was actually written.
 *
 * - id only in `after` → added
 * - id live before, archived/superseded after → deleted (soft — reversible)
 * - id live in both but content hash changed → updated
 */
export function computeAppliedChanges(
  before: MemoryFingerprint[],
  after: MemoryFingerprint[],
): AppliedChanges {
  const beforeById = new Map(before.map((r) => [r.id, r]));
  const addedIds: string[] = [];
  const updatedIds: string[] = [];
  const deletedIds: string[] = [];

  for (const row of after) {
    const prev = beforeById.get(row.id);
    if (!prev) {
      addedIds.push(row.id);
      continue;
    }
    if (LIVE_STATUSES.has(prev.status) && !LIVE_STATUSES.has(row.status)) {
      deletedIds.push(row.id);
    } else if (
      LIVE_STATUSES.has(prev.status) &&
      LIVE_STATUSES.has(row.status) &&
      prev.contentHash !== row.contentHash
    ) {
      updatedIds.push(row.id);
    }
  }

  return { addedIds, updatedIds, deletedIds };
}

/** Render the diff summary that gets logged at the end of a run. */
export function formatDiffSummary(diff: SnapshotDiff): string {
  const lines: string[] = [];
  lines.push(`Memories added:   ${diff.added.length}`);
  lines.push(`Memories removed: ${diff.removed.length}`);
  lines.push(`Unchanged:        ${diff.unchanged}`);
  const types = new Set([
    ...Object.keys(diff.typeDistributionBefore),
    ...Object.keys(diff.typeDistributionAfter),
  ]);
  lines.push("Type distribution (before -> after):");
  for (const type of [...types].sort()) {
    const b = diff.typeDistributionBefore[type] ?? 0;
    const a = diff.typeDistributionAfter[type] ?? 0;
    lines.push(`  ${type}: ${b} -> ${a}`);
  }
  return lines.join("\n");
}

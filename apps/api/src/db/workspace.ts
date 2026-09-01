/**
 * withWorkspace(workspaceId, fn) — the single enforcement point for
 * multi-tenant row-level security (issue #1393, part of #17).
 *
 * Pins one connection from a session-capable pool, issues
 * `set_config('app.workspace_id', $1, ...)` on it, and runs `fn` (plus
 * everything `fn` awaits) with the shared `db` export transparently routed to
 * that connection via AsyncLocalStorage. The RLS policies added in migration
 * 0091 read `current_setting('app.workspace_id', true)`, so every query on
 * the pinned connection — including the ~400 pre-existing call sites that
 * never mention workspace_id — is constrained to exactly one tenant.
 *
 * WHY A PINNED SESSION AND NOT `BEGIN; SET LOCAL ...` AROUND `fn`
 * ===============================================================
 * Issue #1393 sketches a transaction wrapper. A literal single transaction
 * around `fn` would violate the issue's own hard constraint ("no behaviour
 * change in single-tenant mode") for the long-lived entry points:
 *   - the Slack respond pipeline and job executor run for MINUTES; holding
 *     one transaction open that long means conversation_locks /
 *     event_locks / job-claim writes stay uncommitted (and row-locked), so
 *     the Stop button, duplicate-event dedup, and duplicate-job claiming —
 *     all of which rely on cross-invocation visibility of committed rows —
 *     would block or break.
 * A session-scoped GUC on a pinned connection gives RLS the exact same
 * input (`current_setting('app.workspace_id')`) while keeping today's
 * per-statement autocommit visibility semantics. `db.transaction(...)`
 * still works inside `fn` (it runs on the pinned connection, where the GUC
 * is visible). The GUC is RESET before the connection returns to the pool.
 *
 * Everything stays on workspace 'default' in Phase 0 — entry points pass the
 * existing `process.env.DEFAULT_WORKSPACE_ID || "default"` resolution.
 */
import * as schema from "@aura/db/schema";
import { db, type Database } from "./client.js";
import { workspaceStorage, type WorkspaceStore } from "./workspace-context.js";
import { logger } from "../lib/logger.js";

/** Minimal surface of a pg / neon-serverless pooled client we rely on. */
interface PooledClient {
  query(text: string, params?: unknown[]): Promise<unknown>;
  release(destroy?: unknown): void;
}

interface PoolLike {
  connect(): Promise<PooledClient>;
}

type DriverKind = "neon" | "pg";

let poolPromise: Promise<{ pool: PoolLike; kind: DriverKind }> | null = null;

function isNeonUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".neon.tech") || host.endsWith(".neon.build");
  } catch {
    return false;
  }
}

/**
 * Lazily create the session-capable pool. Neon URLs use the serverless
 * driver's WebSocket Pool; anything else (local Postgres in dev/tests) uses
 * node-postgres. Both are dynamically imported so neither loads on the
 * neon-http fast path used outside withWorkspace().
 */
async function getPool(): Promise<{ pool: PoolLike; kind: DriverKind }> {
  if (!poolPromise) {
    poolPromise = (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("withWorkspace: DATABASE_URL is not set");
      if (isNeonUrl(url)) {
        const { Pool, neonConfig } = await import("@neondatabase/serverless");
        if (typeof WebSocket === "undefined") {
          // Node < 22 has no global WebSocket; the neon Pool needs one.
          const ws = await import("ws");
          neonConfig.webSocketConstructor = ws.default as unknown as typeof WebSocket;
        }
        return { pool: new Pool({ connectionString: url }) as unknown as PoolLike, kind: "neon" as const };
      }
      const pg = await import("pg");
      return { pool: new pg.default.Pool({ connectionString: url }) as unknown as PoolLike, kind: "pg" as const };
    })();
    poolPromise.catch(() => {
      // Allow a retry on the next call instead of caching the failure forever.
      poolPromise = null;
    });
  }
  return poolPromise;
}

async function buildHandle(client: PooledClient, kind: DriverKind): Promise<Database> {
  if (kind === "neon") {
    const { drizzle } = await import("drizzle-orm/neon-serverless");
    return drizzle(client as never, { schema }) as unknown as Database;
  }
  const { drizzle } = await import("drizzle-orm/node-postgres");
  return drizzle(client as never, { schema }) as unknown as Database;
}

/**
 * Unit-test pass-through: the existing vitest suite mocks `../db/client.js`
 * and calls entry points (job executor, Slack event handlers, webhooks)
 * without any database. In that mode withWorkspace() must not try to open a
 * real connection — it validates its input and runs `fn` against the
 * (mocked) shared handle. The workspace-isolation integration test opts back
 * into the real path with WORKSPACE_ISOLATION_TEST=1.
 */
function isUnitTestPassthrough(): boolean {
  return process.env.VITEST === "true" && process.env.WORKSPACE_ISOLATION_TEST !== "1";
}

/**
 * Run `fn` with all database access scoped to `workspaceId`.
 *
 * Re-entrant: nesting with the same workspaceId reuses the outer scope's
 * pinned connection; nesting with a different workspaceId opens a fresh
 * scope (the inner scope wins for its duration).
 *
 * @throws if workspaceId is missing/empty — callers must resolve a tenant
 *         before touching the database.
 */
export async function withWorkspace<T>(
  workspaceId: string,
  fn: (db: Database) => Promise<T> | T,
): Promise<T> {
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    throw new Error(
      "withWorkspace: workspaceId must be a non-empty string (got " +
        JSON.stringify(workspaceId) +
        ")",
    );
  }

  const existing = workspaceStorage.getStore();
  if (existing?.active && existing.workspaceId === workspaceId) {
    return fn(existing.handle as Database);
  }

  if (isUnitTestPassthrough()) {
    return fn(db);
  }

  const { pool, kind } = await getPool();
  const client = await pool.connect();
  const store: WorkspaceStore = { workspaceId, handle: null, active: false };
  let broken = false;
  try {
    // set_config(..., false) = session-scoped on this pinned connection.
    await client.query("SELECT set_config('app.workspace_id', $1, false)", [workspaceId]);
    store.handle = await buildHandle(client, kind);
    store.active = true;
    return await workspaceStorage.run(store, () => fn(store.handle as Database));
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    store.active = false;
    try {
      await client.query("RESET app.workspace_id");
      client.release(broken || undefined);
    } catch (resetError) {
      // Never return a connection with a lingering workspace GUC to the pool.
      logger.warn("withWorkspace: RESET failed — destroying pinned connection", {
        workspaceId,
        error: String(resetError).slice(0, 200),
      });
      try {
        client.release(true);
      } catch {
        // already destroyed
      }
    }
  }
}

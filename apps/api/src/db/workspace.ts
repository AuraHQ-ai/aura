/**
 * withWorkspace(workspaceId, fn) — the single enforcement point for
 * multi-tenant row-level security (issue #1393, part of #17).
 *
 * Establishes an ambient workspace scope (AsyncLocalStorage) and routes the
 * shared `db` export through a handle that carries the tenant id into every
 * statement as a transaction-local GUC, so the RLS policies added in
 * migration 0091 evaluate against the right tenant — including the ~400
 * pre-existing call sites that never mention workspace_id.
 *
 * TRANSPORT — one HTTP round trip on the hot path (review round 3)
 * ===============================================================
 * The default (Neon) path uses neon-http's BATCHED transaction:
 *
 *     sql.transaction([
 *       sql.query("select set_config('app.workspace_id', $1, true)", [wsId]),
 *       sql.query(<the actual statement>),
 *     ])
 *
 * Neon sends this as a real server-side BEGIN … COMMIT in a SINGLE HTTP
 * request, so the SET LOCAL and the statement run on the same backend by
 * construction — the pooler-multiplexing problem (round 2) cannot apply,
 * because there is exactly one hop. Measured on the production `-pooler` DSN:
 * ~163 ms scoped vs ~155 ms unscoped (~6% overhead), versus the ~616 ms (4x,
 * four round trips) of a pooled BEGIN/SET LOCAL/stmt/COMMIT cycle. That 4x
 * was unacceptable as the default given #1382 (turn wall-clock deadline is
 * the current top runtime failure mode).
 *
 * WHY NOT A SESSION GUC (round 2) — still true
 * ============================================
 * Production DATABASE_URL is the Neon `-pooler` host (PgBouncer, transaction
 * pooling). A session-scoped GUC (`set_config(..., false)`) on a pooled
 * client does NOT follow the client across statements — under concurrency it
 * evaluates RLS against another tenant's id (measured: 3/40 scopes correct).
 * The GUC must be transaction-local (`set_config(..., true)`), which the
 * batched transaction provides.
 *
 * WHY NOT ONE TRANSACTION AROUND `fn`
 * ===================================
 * The Slack pipeline and job executor run for minutes. One transaction that
 * long would leave conversation_locks / event_locks / job-claim writes
 * uncommitted and row-locked (breaking Stop, event dedup, and duplicate-job
 * claiming). The scope wraps each statement, not the turn: nothing is held
 * across `fn`, so a dropped connection mid-turn costs one statement, and the
 * GUC dies with each statement's implicit COMMIT.
 *
 * INTERACTIVE TRANSACTIONS
 * ========================
 * neon-http cannot run interactive multi-statement transactions, exactly like
 * the base `db` export. The handful of call sites that need one use
 * `withTransaction()` (db/tx.ts), which pins a WebSocket pool connection,
 * issues a real BEGIN, injects the same SET LOCAL, and COMMITs — correct
 * through the pooler because PgBouncer pins the backend for the duration of
 * an explicit transaction. That path is unchanged.
 *
 * LOCAL / NON-NEON
 * ================
 * neon-http only talks to Neon. For a non-Neon DATABASE_URL (local Postgres /
 * PgBouncer in dev and the isolation test) withWorkspace() falls back to the
 * pooled per-statement transaction (WorkspaceScopedClient below), which is
 * the same primitive the pooler-concurrency test exercises directly.
 *
 * Everything stays on workspace 'default' in Phase 0 — entry points pass the
 * existing `process.env.DEFAULT_WORKSPACE_ID || "default"` resolution.
 */
import * as schema from "@aura/db/schema";
import { db, neonHttpClient, type Database } from "./client.js";
import { workspaceStorage, type WorkspaceStore } from "./workspace-context.js";
import { logger } from "../lib/logger.js";

/** Minimal surface of a pg / neon-serverless pooled client we rely on. */
export interface PooledClient {
  query(text: unknown, params?: unknown[]): Promise<unknown>;
  release(destroy?: unknown): void;
}

export interface PoolLike {
  connect(): Promise<PooledClient>;
}

export type DriverKind = "neon" | "pg";

/** The neon-http client shape we depend on (`.query` + `.transaction`). */
type NeonHttpClient = {
  query: (sql: string, params?: unknown[], opts?: unknown) => Promise<unknown>;
  transaction: (queries: unknown[], opts?: unknown) => Promise<unknown[]>;
};

/**
 * GUC scope mode. "transaction" (SET LOCAL — set_config(..., true)) is the
 * ONLY mode that is correct through a transaction pooler; "session" exists
 * solely so the boot guard below can fail closed if anyone ever flips it back.
 */
const GUC_SCOPE: "transaction" | "session" = "transaction";

let poolPromise: Promise<{ pool: PoolLike; kind: DriverKind }> | null = null;

export function isNeonUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".neon.tech") || host.endsWith(".neon.build");
  } catch {
    return false;
  }
}

/** Neon's PgBouncer hosts carry a `-pooler` marker in the endpoint name. */
export function isTransactionPoolerHost(url: string): boolean {
  try {
    return new URL(url).hostname.includes("-pooler");
  } catch {
    return false;
  }
}

/**
 * Fail-closed configuration guard (review round 2): a session-scoped GUC on
 * a transaction-pooled host silently evaluates RLS against the wrong tenant.
 * Never degrade silently — refuse to build the pool at all.
 */
function assertGucScopeSafeForHost(url: string): void {
  if ((GUC_SCOPE as string) === "session" && isTransactionPoolerHost(url)) {
    throw new Error(
      "withWorkspace: refusing to start — GUC_SCOPE is 'session' but DATABASE_URL " +
        "points at a transaction pooler (-pooler host). Session GUCs do not follow " +
        "statements across pooled backends, so RLS would evaluate against another " +
        "tenant's workspace id under concurrency. Use transaction scoping (SET LOCAL) " +
        "or a direct (non-pooler) connection string.",
    );
  }
}

/**
 * Lazily create the WebSocket pool used by withTransaction (db/tx.ts) and by
 * the non-Neon fallback path of withWorkspace. The default Neon single-
 * statement path does NOT use this pool — it goes over neon-http — so on
 * production no WebSocket pool is created unless an interactive transaction
 * runs. Both drivers are dynamically imported so neither loads on the fast
 * path.
 */
export async function getSessionPool(): Promise<{ pool: PoolLike; kind: DriverKind }> {
  if (!poolPromise) {
    poolPromise = (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("withWorkspace: DATABASE_URL is not set");
      assertGucScopeSafeForHost(url);
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

/**
 * Boot-time privilege assertion (issue #1393 review round 1): the RLS
 * policies are INERT for roles with BYPASSRLS or superuser (BYPASSRLS beats
 * FORCE ROW LEVEL SECURITY — FORCE only removes the *owner* exemption). On
 * production Neon, `neondb_owner` has BYPASSRLS, which is exactly why
 * migration 0092 introduces the non-bypassing `aura_app` role. This check
 * runs once per process, on the first workspace scope: if the connected role
 * is RLS-exempt it logs a hard error (single-tenant prod keeps running — the
 * failure mode is "containment inert", not "app down") and THROWS when
 * MULTI_TENANT=true, because in multi-tenant mode an exempt role means
 * cross-tenant reads.
 *
 * The probe is transport-agnostic: the caller supplies a function that runs
 * the role query on whatever connection the scope is about to use.
 */
type RoleRow = { role: string; rolbypassrls: boolean; rolsuper: boolean };
const ROLE_QUERY =
  "SELECT current_user::text AS role, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user";
let roleAssertionPromise: Promise<void> | null = null;

function assertNonBypassingRole(probe: () => Promise<RoleRow | undefined>): Promise<void> {
  if (!roleAssertionPromise) {
    roleAssertionPromise = (async () => {
      const row = await probe();
      if (!row) return;
      if (row.rolbypassrls || row.rolsuper) {
        const message =
          `RLS containment is INERT: database role "${row.role}" has ` +
          `${row.rolsuper ? "SUPERUSER" : "BYPASSRLS"}, which exempts it from every ` +
          `row-level-security policy (FORCE does not override role attributes). ` +
          `Point DATABASE_URL at the non-privileged "aura_app" role (migration 0092, ` +
          `see the PR #1396 runbook).`;
        logger.error(message, { role: row.role, rolbypassrls: row.rolbypassrls, rolsuper: row.rolsuper });
        if (process.env.MULTI_TENANT === "true") {
          throw new Error(message);
        }
      }
    })();
    roleAssertionPromise.catch(() => {
      // A thrown assertion (MULTI_TENANT) must stay thrown for every caller;
      // only transient query failures should be retried.
      if (process.env.MULTI_TENANT !== "true") roleAssertionPromise = null;
    });
  }
  return roleAssertionPromise;
}

function firstRow(result: unknown): RoleRow | undefined {
  const rows = ((result as { rows?: unknown[] })?.rows ?? result) as RoleRow[] | undefined;
  return Array.isArray(rows) ? rows[0] : undefined;
}

// ── Neon-http batched-transaction handle (default hot path) ──────────────────

/**
 * A drizzle "client" ({ query }) that batches SET LOCAL app.workspace_id +
 * the statement into one neon-http `transaction([...])` — a single server-
 * side BEGIN…COMMIT over one HTTP request. drizzle-orm/neon-http calls
 * `client.query(sql, params, opts)` and awaits the result; neon applies the
 * result-shaping opts (arrayMode/fullResults) at the transaction level, so
 * the second element is shaped exactly as a normal `client.query` would be.
 */
export function httpScopedClient(
  client: NeonHttpClient,
  workspaceId: string,
): { query: (sql: string, params?: unknown[], opts?: unknown) => Promise<unknown> } {
  return {
    query: async (sqlText, params = [], opts) => {
      const setter = client.query(
        "SELECT set_config('app.workspace_id', $1, true)",
        [workspaceId],
        opts,
      );
      const stmt = client.query(sqlText, params, opts);
      const out = await client.transaction([setter, stmt], opts);
      return out[1];
    },
  };
}

export async function buildHttpScopedHandle(
  client: NeonHttpClient,
  workspaceId: string,
): Promise<Database> {
  const { drizzle } = await import("drizzle-orm/neon-http");
  return drizzle(httpScopedClient(client, workspaceId) as never, { schema }) as unknown as Database;
}

// ── Pooled per-statement handle (non-Neon fallback + withTransaction) ────────

function statementText(queryOrConfig: unknown): string {
  if (typeof queryOrConfig === "string") return queryOrConfig;
  const text = (queryOrConfig as { text?: unknown } | null | undefined)?.text;
  return typeof text === "string" ? text : "";
}

/**
 * The pooled drizzle "client": executes every statement inside its own
 * explicit transaction carrying SET LOCAL app.workspace_id, and pins one
 * pooled connection for the duration of an explicit drizzle
 * `db.transaction()` (recognized by the `begin`/`commit`/`rollback`
 * statements drizzle issues), injecting the same SET LOCAL right after BEGIN.
 *
 * Used ONLY on the non-Neon path (local Postgres / PgBouncer): neon-http
 * cannot reach a non-Neon host. One instance per withWorkspace() scope.
 */
export class WorkspaceScopedClient implements PooledClient {
  private txClient: PooledClient | null = null;

  constructor(
    private readonly pool: PoolLike,
    private readonly workspaceId: string,
  ) {}

  async query(queryOrConfig: unknown, params?: unknown[]): Promise<unknown> {
    const normalized = statementText(queryOrConfig).trim().toLowerCase();

    if (this.txClient) {
      const client = this.txClient;
      try {
        const result = await client.query(queryOrConfig, params);
        if (normalized === "commit" || normalized === "rollback") {
          this.txClient = null;
          client.release();
        }
        return result;
      } catch (error) {
        if (normalized === "commit" || normalized === "rollback") {
          this.txClient = null;
          client.release(true);
        }
        throw error;
      }
    }

    if (normalized === "begin" || normalized.startsWith("begin ")) {
      const client = await this.pool.connect();
      try {
        const result = await client.query(queryOrConfig, params);
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [this.workspaceId]);
        this.txClient = client;
        return result;
      } catch (error) {
        client.release(true);
        throw error;
      }
    }

    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [this.workspaceId]);
      const result = await client.query(queryOrConfig, params);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      broken = true;
      try {
        await client.query("ROLLBACK");
        broken = false;
      } catch {
        // connection is in an unknown state — destroy it below
      }
      throw error;
    } finally {
      client.release(broken || undefined);
    }
  }

  dispose(): void {
    if (this.txClient) {
      const client = this.txClient;
      this.txClient = null;
      try {
        client.release(true);
      } catch {
        // already destroyed
      }
    }
  }

  release(): void {
    this.dispose();
  }
}

export async function buildPooledScopedHandle(
  pool: PoolLike,
  kind: DriverKind,
  workspaceId: string,
): Promise<{ handle: Database; dispose: () => void }> {
  const scopedClient = new WorkspaceScopedClient(pool, workspaceId);
  let handle: Database;
  if (kind === "neon") {
    const { drizzle } = await import("drizzle-orm/neon-serverless");
    handle = drizzle(scopedClient as never, { schema }) as unknown as Database;
  } else {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    handle = drizzle(scopedClient as never, { schema }) as unknown as Database;
  }
  return { handle, dispose: () => scopedClient.dispose() };
}

/**
 * Unit-test pass-through: the existing vitest suite mocks `../db/client.js`
 * and calls entry points (job executor, Slack event handlers, webhooks)
 * without any database. In that mode withWorkspace() must not try to open a
 * real connection — it validates its input and runs `fn` against the
 * (mocked) shared handle. The integration suites opt back into the real path
 * with WORKSPACE_ISOLATION_TEST=1.
 */
function isUnitTestPassthrough(): boolean {
  return process.env.VITEST === "true" && process.env.WORKSPACE_ISOLATION_TEST !== "1";
}

/**
 * Run `fn` with all database access scoped to `workspaceId`.
 *
 * Re-entrant: nesting with the same workspaceId reuses the outer scope's
 * handle; nesting with a different workspaceId opens a fresh scope (the
 * inner scope wins for its duration).
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

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("withWorkspace: DATABASE_URL is not set");

  // ── Default hot path: Neon over HTTP, batched SET LOCAL + statement ───────
  if (isNeonUrl(url)) {
    const client = neonHttpClient as unknown as NeonHttpClient;
    await assertNonBypassingRole(async () =>
      firstRow(await client.query(ROLE_QUERY, [], { arrayMode: false, fullResults: true })),
    );
    const handle = await buildHttpScopedHandle(client, workspaceId);
    const store: WorkspaceStore = { workspaceId, handle, active: true };
    try {
      return await workspaceStorage.run(store, () => fn(handle));
    } finally {
      store.active = false;
    }
  }

  // ── Non-Neon fallback (local Postgres / PgBouncer): pooled per-statement ──
  const { pool, kind } = await getSessionPool();
  await assertNonBypassingRole(async () => {
    const c = await pool.connect();
    try {
      return firstRow(await c.query(ROLE_QUERY));
    } finally {
      c.release();
    }
  });
  const { handle, dispose } = await buildPooledScopedHandle(pool, kind, workspaceId);
  const store: WorkspaceStore = { workspaceId, handle, active: true };
  try {
    return await workspaceStorage.run(store, () => fn(handle));
  } finally {
    store.active = false;
    dispose();
  }
}

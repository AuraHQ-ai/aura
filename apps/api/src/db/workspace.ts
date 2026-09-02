/**
 * withWorkspace(workspaceId, fn) — the single enforcement point for
 * multi-tenant row-level security (issue #1393, part of #17).
 *
 * Establishes an ambient workspace scope (AsyncLocalStorage) and routes the
 * shared `db` export through a handle that executes EVERY statement inside
 * its own short explicit transaction:
 *
 *     BEGIN;
 *     SELECT set_config('app.workspace_id', $1, true);   -- SET LOCAL
 *     <the actual statement>;
 *     COMMIT;
 *
 * so the RLS policies added in migration 0091 see the tenant id on the exact
 * server backend that executes the statement — including the ~400
 * pre-existing call sites that never mention workspace_id.
 *
 * WHY TRANSACTION-SCOPED (SET LOCAL), NOT A SESSION GUC — review round 2
 * ======================================================================
 * Production DATABASE_URL points at the Neon `-pooler` host: PgBouncer in
 * TRANSACTION pooling mode, where consecutive statements outside an explicit
 * transaction are NOT guaranteed to run on the same server backend, and
 * session state does not follow the client. A session-scoped GUC on a pooled
 * client therefore evaluates RLS against ANOTHER tenant's id under
 * concurrency (measured on the production DSN: 3/40 scopes read back their
 * own id; the rest read another tenant's or NULL). Inside BEGIN…COMMIT,
 * PgBouncer pins the backend, so SET LOCAL travels with each statement:
 * 40/40 correct on the same host. The pooler-concurrency test
 * (workspace-pooler-concurrency.test.ts) fails any regression back to
 * session scoping.
 *
 * WHY NOT ONE TRANSACTION AROUND `fn`
 * ===================================
 * The Slack pipeline and job executor run for minutes. One transaction that
 * long would leave conversation_locks / event_locks / job-claim writes
 * uncommitted and row-locked (breaking Stop, event dedup, and duplicate-job
 * claiming) and is its own outage on a pooled connection. The transaction
 * wraps the DB work — one statement at a time — not the turn. Explicit
 * `db.transaction(...)` calls inside a scope still work: the facade pins one
 * pooled connection for the duration of that transaction and injects the
 * same SET LOCAL right after BEGIN.
 *
 * No connection is held across `fn`: each statement borrows one from the
 * pool and returns it immediately, so a dropped connection mid-turn only
 * fails one statement, and nothing needs RESET (SET LOCAL dies with COMMIT).
 *
 * Everything stays on workspace 'default' in Phase 0 — entry points pass the
 * existing `process.env.DEFAULT_WORKSPACE_ID || "default"` resolution.
 */
import * as schema from "@aura/db/schema";
import { db, type Database } from "./client.js";
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

/**
 * GUC scope mode. "transaction" (SET LOCAL inside BEGIN/COMMIT) is the ONLY
 * mode that is correct through a transaction pooler; "session" exists solely
 * so the boot guard below can fail closed if anyone ever flips it back.
 */
const GUC_SCOPE: "transaction" | "session" = "transaction";

let poolPromise: Promise<{ pool: PoolLike; kind: DriverKind }> | null = null;

function isNeonUrl(url: string): boolean {
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
 * Lazily create the session-capable pool shared by all workspace scopes (and
 * by withTransaction in tx.js). Neon URLs use the serverless driver's
 * WebSocket Pool; anything else (local Postgres / PgBouncer in dev and
 * tests) uses node-postgres. Both are dynamically imported so neither loads
 * on the neon-http fast path used outside withWorkspace().
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
 */
let roleAssertionPromise: Promise<void> | null = null;

function assertNonBypassingRole(pool: PoolLike): Promise<void> {
  if (!roleAssertionPromise) {
    roleAssertionPromise = (async () => {
      const client = await pool.connect();
      try {
        const result = (await client.query(
          "SELECT current_user::text AS role, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user",
        )) as { rows?: Array<{ role: string; rolbypassrls: boolean; rolsuper: boolean }> };
        const row = result.rows?.[0];
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
      } finally {
        client.release();
      }
    })();
    roleAssertionPromise.catch(() => {
      // A thrown assertion (MULTI_TENANT) must stay thrown for every caller;
      // only transient query failures should be retried. Distinguishing the
      // two: the assertion error message is stable, so re-running is safe
      // and cheap either way.
      if (process.env.MULTI_TENANT !== "true") roleAssertionPromise = null;
    });
  }
  return roleAssertionPromise;
}

function statementText(queryOrConfig: unknown): string {
  if (typeof queryOrConfig === "string") return queryOrConfig;
  const text = (queryOrConfig as { text?: unknown } | null | undefined)?.text;
  return typeof text === "string" ? text : "";
}

/**
 * The drizzle "client": executes every statement inside its own explicit
 * transaction carrying SET LOCAL app.workspace_id, and pins one pooled
 * connection for the duration of an explicit drizzle `db.transaction()`
 * (recognized by the `begin` / `commit` / `rollback` statements drizzle
 * issues), injecting the same SET LOCAL right after BEGIN.
 *
 * One instance per withWorkspace() scope — never shared across scopes.
 */
class WorkspaceScopedClient implements PooledClient {
  private txClient: PooledClient | null = null;

  constructor(
    private readonly pool: PoolLike,
    private readonly workspaceId: string,
  ) {}

  async query(queryOrConfig: unknown, params?: unknown[]): Promise<unknown> {
    const normalized = statementText(queryOrConfig).trim().toLowerCase();

    // Inside an explicit drizzle transaction: pass through on the pinned
    // connection (PgBouncer pins the backend between BEGIN and COMMIT).
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

    // drizzle's db.transaction() opens with `begin` (optionally with
    // isolation/access modifiers) — pin a connection and inject SET LOCAL.
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

    // Single statement: its own short transaction with SET LOCAL.
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
        broken = false; // clean rollback — connection is reusable
      } catch {
        // connection is in an unknown state — destroy it below
      }
      throw error;
    } finally {
      client.release(broken || undefined);
    }
  }

  /** Destroy a transaction connection left dangling by an aborted scope. */
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

  // PooledClient interface parity; drizzle never calls this on the handle.
  release(): void {
    this.dispose();
  }
}

async function buildHandle(
  client: WorkspaceScopedClient,
  kind: DriverKind,
): Promise<Database> {
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

  const { pool, kind } = await getSessionPool();
  await assertNonBypassingRole(pool);

  const scopedClient = new WorkspaceScopedClient(pool, workspaceId);
  const handle = await buildHandle(scopedClient, kind);
  const store: WorkspaceStore = { workspaceId, handle, active: true };
  try {
    return await workspaceStorage.run(store, () => fn(handle));
  } finally {
    store.active = false;
    scopedClient.dispose();
  }
}

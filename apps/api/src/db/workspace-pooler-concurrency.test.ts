/**
 * Adversarial transport test for withWorkspace() (issue #1393, review rounds
 * 2 & 3). Runs the workspace-scoping matrix against BOTH transports the
 * wrapper can use, because each has caught a production-only bug the other
 * couldn't see:
 *
 *   - POOLED handle (WorkspaceScopedClient over node-postgres): the non-Neon
 *     fallback. Exercised through a REAL local PgBouncer in TRANSACTION
 *     pooling mode (started by scripts/workspace-isolation-test.sh with a
 *     small server pool to force backend multiplexing). This is the leg that
 *     went red in round 2 against a session-scoped GUC — `SET LOCAL` inside
 *     BEGIN/COMMIT is what makes it green. Full read+write matrix, incl. a
 *     cross-tenant RLS read and WITH CHECK.
 *
 *   - HTTP handle (neon-http batched transaction): the DEFAULT production
 *     path (round 3). `SET LOCAL app.workspace_id` + the statement travel in
 *     ONE HTTP request (`sql.transaction([...])`), so pooler multiplexing
 *     cannot apply — it passes trivially. It stays in the matrix so a future
 *     refactor cannot silently reintroduce the 4x-slower pooled path for
 *     single statements without a test noticing. Plus a LATENCY assertion:
 *     a scoped single statement must not cost more than 1.3x an unscoped one
 *     (round 3 measured the pooled default at ~4x; #1382 makes that a
 *     deadline-kill risk). Needs a real Neon DSN (NEON_HTTP_TEST_URL, set by
 *     the runner from the ambient production DATABASE_URL); the http leg is
 *     read-only.
 *
 * Run via: pnpm --filter aura-api test:workspace-isolation (sets
 * WORKSPACE_POOLER_TEST=1, DATABASE_URL=local pooler, DIRECT_DATABASE_URL,
 * NEON_HTTP_TEST_URL). Skipped in the normal unit suite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";

const ENABLED =
  process.env.WORKSPACE_ISOLATION_TEST === "1" &&
  process.env.WORKSPACE_POOLER_TEST === "1";

const HTTP_URL = process.env.NEON_HTTP_TEST_URL;

const SCOPES = 48;
const gap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rows = (out: unknown): Array<Record<string, unknown>> =>
  ((out as { rows?: Array<Record<string, unknown>> }).rows ?? out) as Array<
    Record<string, unknown>
  >;

// ── Pooled leg: real PgBouncer, full read+write matrix ──────────────────────

describe.runIf(ENABLED)("workspace scoping — POOLED handle via PgBouncer (RLS, #1393 r2)", () => {
  let withWorkspace: typeof import("./workspace.js").withWorkspace;
  let sql: typeof import("drizzle-orm").sql;
  let schema: typeof import("@aura/db/schema");
  let directClient: pg.Client;

  beforeAll(async () => {
    ({ withWorkspace } = await import("./workspace.js"));
    ({ sql } = await import("drizzle-orm"));
    schema = await import("@aura/db/schema");

    // Maintenance/seeding sanity client on the DIRECT connection (operator
    // sessions are direct per the 0091 runbook; session GUCs are unsafe on
    // the pooler by definition of this very test).
    const direct = process.env.DIRECT_DATABASE_URL;
    if (!direct) throw new Error("DIRECT_DATABASE_URL is required for the pooler test");
    const pgMod = await import("pg");
    directClient = new pgMod.default.Client({ connectionString: direct });
    await directClient.connect();

    await directClient.query(
      `INSERT INTO workspaces (id, name) VALUES ('ws-conc-a', 'Conc A'), ('ws-conc-b', 'Conc B')
       ON CONFLICT DO NOTHING`,
    );
    // Seeded through the real wrapper — exercises WITH CHECK through the pooler.
    for (const ws of ["ws-conc-a", "ws-conc-b"] as const) {
      await withWorkspace(ws, async (db) => {
        await db
          .insert(schema.notes)
          .values({
            workspaceId: ws,
            topic: `conc-topic-${ws}`,
            content: `MARKER-${ws}`,
          })
          .onConflictDoNothing();
      });
    }
  }, 60_000);

  afterAll(async () => {
    await directClient?.end();
  });

  it(`${SCOPES} concurrent scopes each observe exactly their own workspace id across async gaps`, async () => {
    const results = await Promise.all(
      Array.from({ length: SCOPES }, (_, i) =>
        withWorkspace(`ws-conc-${i}`, async (db) => {
          const observed: Array<string | null> = [];
          for (let round = 0; round < 3; round++) {
            await gap(10 + Math.floor(Math.random() * 40));
            const out = await db.execute(
              sql`SELECT current_setting('app.workspace_id', true) AS ws`,
            );
            observed.push((rows(out)[0]?.ws as string | null) ?? null);
          }
          return { expected: `ws-conc-${i}`, observed };
        }),
      ),
    );

    const wrong = results.filter((r) => r.observed.some((ws) => ws !== r.expected));
    expect(
      wrong.slice(0, 10).map((w) => `${w.expected} observed ${JSON.stringify(w.observed)}`),
    ).toEqual([]);
    expect(wrong.length).toBe(0);
  }, 60_000);

  it("concurrent real reads through RLS never return another tenant's rows", async () => {
    const results = await Promise.all(
      Array.from({ length: SCOPES }, (_, i) => {
        const ws = i % 2 === 0 ? "ws-conc-a" : "ws-conc-b";
        const other = ws === "ws-conc-a" ? "ws-conc-b" : "ws-conc-a";
        return withWorkspace(ws, async (db) => {
          await gap(10 + Math.floor(Math.random() * 40));
          const out = await db.execute(
            sql`SELECT content FROM notes WHERE topic LIKE 'conc-topic-%'`,
          );
          const contents = rows(out).map((r) => String(r.content));
          return { ws, other, contents };
        });
      }),
    );

    const problems: string[] = [];
    for (const r of results) {
      if (r.contents.length !== 1 || r.contents[0] !== `MARKER-${r.ws}`) {
        problems.push(`${r.ws} read ${JSON.stringify(r.contents)}`);
      }
      if (r.contents.some((c) => c.includes(r.other))) {
        problems.push(`${r.ws} LEAKED ${r.other} rows`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(problems.length).toBe(0);
  }, 60_000);
});

// ── HTTP leg: the default production transport (neon-http batched txn) ───────

describe.runIf(ENABLED && !!HTTP_URL)(
  "workspace scoping — HTTP batched handle over Neon (RLS + latency, #1393 r3)",
  () => {
    let buildHttpScopedHandle: typeof import("./workspace.js").buildHttpScopedHandle;
    let isNeonUrl: typeof import("./workspace.js").isNeonUrl;
    let sql: typeof import("drizzle-orm").sql;
    let schema: typeof import("@aura/db/schema");
    // The neon-http client + an UNSCOPED drizzle baseline for the latency ratio.
    let neonClient: unknown;
    let baselineDb: { execute: (q: unknown) => Promise<unknown> };

    beforeAll(async () => {
      ({ buildHttpScopedHandle, isNeonUrl } = await import("./workspace.js"));
      ({ sql } = await import("drizzle-orm"));
      schema = await import("@aura/db/schema");
      const { neon } = await import("@neondatabase/serverless");
      const { drizzle } = await import("drizzle-orm/neon-http");
      neonClient = neon(HTTP_URL as string);
      baselineDb = drizzle(neonClient as never, { schema }) as never;
    }, 60_000);

    it("the production DSN routes withWorkspace to the HTTP transport (not the pooled path)", () => {
      // withWorkspace() takes the neon-http batched-transaction branch iff
      // isNeonUrl(DATABASE_URL). Asserting it here ties the fast path to the
      // real production DSN: a refactor that narrows this predicate would send
      // production back onto the 4x pooled path and fail this test.
      expect(isNeonUrl(HTTP_URL as string)).toBe(true);
    });

    it(`${SCOPES} concurrent HTTP scopes each observe exactly their own workspace id`, async () => {
      const results = await Promise.all(
        Array.from({ length: SCOPES }, async (_unused, i) => {
          const handle = await buildHttpScopedHandle(neonClient as never, `ws-http-${i}`);
          const observed: Array<string | null> = [];
          for (let round = 0; round < 3; round++) {
            await gap(Math.floor(Math.random() * 40));
            const out = await handle.execute(
              sql`SELECT current_setting('app.workspace_id', true) AS ws`,
            );
            observed.push((rows(out)[0]?.ws as string | null) ?? null);
          }
          return { expected: `ws-http-${i}`, observed };
        }),
      );
      const wrong = results.filter((r) => r.observed.some((ws) => ws !== r.expected));
      expect(
        wrong.slice(0, 10).map((w) => `${w.expected} observed ${JSON.stringify(w.observed)}`),
      ).toEqual([]);
      expect(wrong.length).toBe(0);
    }, 60_000);

    it("the batched GUC does not leak to the next unscoped statement on the same client", async () => {
      await buildHttpScopedHandle(neonClient as never, "ws-http-leakcheck").then((h) =>
        h.execute(sql`SELECT current_setting('app.workspace_id', true) AS ws`),
      );
      const out = await baselineDb.execute(
        sql`SELECT current_setting('app.workspace_id', true) AS ws`,
      );
      // SET LOCAL died with the batched COMMIT — the shared client sees no GUC.
      const ws = rows(out)[0]?.ws;
      expect(ws === null || ws === "").toBe(true);
    }, 30_000);

    it("drizzle row mapping works through the HTTP scoped handle", async () => {
      // Exercises the arrayMode:true + mapResultRow path (not just execute()).
      // Reads the global `workspaces` registry (no RLS, no tenant data).
      const handle = await buildHttpScopedHandle(neonClient as never, "default");
      const out = await handle
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .limit(1);
      expect(Array.isArray(out)).toBe(true);
      if (out.length > 0) expect(typeof out[0].id).toBe("string");
    }, 30_000);

    it("a scoped single statement costs <= 1.3x an unscoped one (round-3 budget)", async () => {
      const ITERS = 20;
      const one = sql`SELECT 1 AS one`;
      const unscoped = () => baselineDb.execute(one);
      const scoped = async () => {
        const h = await buildHttpScopedHandle(neonClient as never, "default");
        return h.execute(one);
      };

      const mean = async (run: () => Promise<unknown>) => {
        for (let i = 0; i < 5; i++) await run(); // warm
        const t0 = performance.now();
        for (let i = 0; i < ITERS; i++) await run();
        return (performance.now() - t0) / ITERS;
      };

      const unscopedMs = await mean(unscoped);
      const scopedMs = await mean(scoped);
      const ratio = scopedMs / unscopedMs;
      // Surfaced in the test log for the PR latency line.
      console.log(
        `[latency] unscoped=${unscopedMs.toFixed(1)}ms scoped=${scopedMs.toFixed(1)}ms ratio=${ratio.toFixed(2)}x`,
      );
      expect(ratio).toBeLessThanOrEqual(1.3);
    }, 60_000);
  },
);

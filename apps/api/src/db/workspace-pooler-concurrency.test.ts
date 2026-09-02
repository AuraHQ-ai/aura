/**
 * Adversarial pooler-concurrency test (issue #1393, review round 2).
 *
 * Production DATABASE_URL points at the Neon `-pooler` host — PgBouncer in
 * TRANSACTION pooling mode, where consecutive statements outside an explicit
 * transaction are NOT guaranteed to hit the same server backend. A
 * session-scoped GUC (`set_config(..., false)`) therefore does not follow the
 * scope: under concurrency, `current_setting('app.workspace_id')` returns
 * ANOTHER tenant's id, and every RLS policy silently evaluates against the
 * wrong tenant — cross-tenant reads AND writes while the code believes it is
 * scoped. Measured on the production DSN before the fix: 3/40 scopes correct.
 *
 * This suite runs through a REAL transaction pooler (the runner script starts
 * a local PgBouncer in transaction mode with a small server pool to force
 * backend multiplexing) and asserts, under >=40 concurrent scopes with async
 * gaps between statements — i.e. what the real pipeline does between queries:
 *
 *   1. every scope observes exactly its own workspace id, repeatedly;
 *   2. real RLS reads never return another tenant's rows.
 *
 * It FAILED against the session-GUC implementation (red) and passes against
 * the SET-LOCAL-per-transaction implementation (green). If someone regresses
 * the wrapper to session scoping, this is the test that catches it — unlike
 * the direct-connection legs, which pass regardless of scoping mode.
 *
 * Run via: pnpm --filter aura-api test:workspace-isolation
 * (WORKSPACE_POOLER_TEST=1 + DATABASE_URL pointing at the pooler is set by
 * scripts/workspace-isolation-test.sh). Skipped in the normal unit suite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";

const ENABLED =
  process.env.WORKSPACE_ISOLATION_TEST === "1" &&
  process.env.WORKSPACE_POOLER_TEST === "1";

const SCOPES = 48;
const gap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rows = (out: unknown): Array<Record<string, unknown>> =>
  ((out as { rows?: Array<Record<string, unknown>> }).rows ?? out) as Array<
    Record<string, unknown>
  >;

describe.runIf(ENABLED)("workspace scoping under a transaction pooler (RLS, #1393 r2)", () => {
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

    // Two tenants with one distinctly-marked note each, seeded through the
    // real wrapper (exercises WITH CHECK through the pooler as well).
    await directClient.query(
      `INSERT INTO workspaces (id, name) VALUES ('ws-conc-a', 'Conc A'), ('ws-conc-b', 'Conc B')
       ON CONFLICT DO NOTHING`,
    );
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

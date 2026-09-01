/**
 * Cross-tenant leak test — the acceptance criterion of issue #1393.
 *
 * Seeds two workspaces (ws-a, ws-b) with OVERLAPPING data (same slack user
 * id, same note topic, same entity canonical name, plus memories, messages
 * and conversation traces), then exercises the REAL read paths under
 * withWorkspace("ws-a", ...) and asserts ZERO rows from ws-b come back.
 *
 * Read paths exercised (production code, not test replicas):
 *   - memory retrieval        retrieveMemories()      (src/memory/retrieve.ts)
 *   - message history         fetchThreadMessages()   (src/memory/store.ts)
 *   - entity resolution       resolveEntityByName()   (src/memory/entity-resolution.ts)
 *   - notes read              db.select().from(notes)
 *   - dashboard routes        /api/dashboard/{conversations,stats,entities,notes}
 *                             through the real Hono app incl. the
 *                             withWorkspace middleware (DEFAULT_WORKSPACE_ID=ws-a)
 *
 * Also proves deny-by-default: a connection with NO app.workspace_id set
 * reads zero rows and cannot write; the documented maintenance GUC restores
 * access for operator sessions.
 *
 * ROLE SHAPE: the suite runs as `aura_app` (migration 0092) — NOSUPERUSER,
 * NOBYPASSRLS, owns nothing — the shape production must have after the
 * DATABASE_URL cutover. It FAILS (in beforeAll) if run under a bypassing,
 * superuser, or table-owning role, because RLS is exempt for those and every
 * assertion here would be vacuous (this is exactly how the first cut of this
 * test green-lit an inert configuration: prod's neondb_owner has BYPASSRLS).
 *
 * Run via: pnpm --filter aura-api test:workspace-isolation
 * (scripts/workspace-isolation-test.sh — provisions a DISPOSABLE local
 * Postgres db, applies the migration chain as the owner role, then runs this
 * suite as aura_app with WORKSPACE_ISOLATION_TEST=1). Skipped entirely in
 * the normal unit-test suite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";

const ENABLED = process.env.WORKSPACE_ISOLATION_TEST === "1";

const WS_A = "ws-a";
const WS_B = "ws-b";
const MARK = { [WS_A]: "WS-A-SECRET", [WS_B]: "WS-B-SECRET" } as const;
const OVERLAP_USER = "U_OVERLAP";
const SHARED_CHANNEL = "C_SHARED";
const SHARED_THREAD_TS = "1700000000.000100";

const DIMS = 1536;
function unitVec(hotIndex: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[hotIndex] = 1;
  return v;
}
/** Query embedding equidistant from both workspaces' memory embeddings. */
function queryVec(): number[] {
  const v = new Array(DIMS).fill(0);
  v[0] = Math.SQRT1_2;
  v[1] = Math.SQRT1_2;
  return v;
}

describe.runIf(ENABLED)("workspace isolation (RLS, issue #1393)", () => {
  let withWorkspace: typeof import("./workspace.js").withWorkspace;
  let schema: typeof import("@aura/db/schema");
  let rawClient: pg.Client;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("localhost") && !process.env.DATABASE_URL?.includes("127.0.0.1")) {
      throw new Error("workspace-isolation test must run against a local disposable database");
    }

    ({ withWorkspace } = await import("./workspace.js"));
    schema = await import("@aura/db/schema");
    const pgMod = await import("pg");
    rawClient = new pgMod.default.Client({ connectionString: process.env.DATABASE_URL });
    await rawClient.connect();

    // HARD GATE (issue #1393 review): this suite must FAIL — not skip, not
    // pass vacuously — when run under an RLS-exempt or table-owning role.
    // BYPASSRLS/SUPERUSER beat FORCE ROW LEVEL SECURITY, so a green run under
    // such a role certifies nothing. Production's neondb_owner HAS BYPASSRLS;
    // the app must connect as the non-bypassing aura_app role (migration
    // 0092), and so must this test.
    const shape = await rawClient.query(
      "SELECT current_user::text AS role, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    const { role, rolbypassrls, rolsuper } = shape.rows[0];
    const owner = await rawClient.query(
      "SELECT pg_get_userbyid(relowner)::text AS owner FROM pg_class WHERE oid = 'public.messages'::regclass",
    );
    if (rolbypassrls || rolsuper || owner.rows[0].owner === role) {
      throw new Error(
        `workspace-isolation test is running under a privileged role: "${role}" ` +
          `(rolbypassrls=${rolbypassrls}, rolsuper=${rolsuper}, ` +
          `messages owner=${owner.rows[0].owner}). RLS is exempt for such roles, so ` +
          `every isolation assertion below would be meaningless. Run via ` +
          `scripts/workspace-isolation-test.sh, which executes this suite as aura_app.`,
      );
    }

    // The workspaces registry itself carries no RLS — seed the two tenants.
    await rawClient.query(
      `INSERT INTO workspaces (id, name) VALUES ($1, 'Workspace A'), ($2, 'Workspace B')
       ON CONFLICT DO NOTHING`,
      [WS_A, WS_B],
    );

    // Seed overlapping tenant data through withWorkspace() so the RLS
    // WITH CHECK clause is exercised on every write.
    for (const ws of [WS_A, WS_B] as const) {
      const hot = ws === WS_A ? 0 : 1;
      await withWorkspace(ws, async (db) => {
        await db.insert(schema.users).values({
          workspaceId: ws,
          slackUserId: OVERLAP_USER,
          displayName: `Overlap User (${MARK[ws]})`,
        });

        await db.insert(schema.notes).values({
          workspaceId: ws,
          topic: "project-phoenix",
          content: `${MARK[ws]} phoenix note`,
          category: "knowledge",
        });

        const [entity] = await db
          .insert(schema.entities)
          .values({
            workspaceId: ws,
            type: "company",
            canonicalName: "Acme Corp",
            summary: `${MARK[ws]} entity summary`,
          })
          .returning({ id: schema.entities.id });

        // alias_lower is a GENERATED ALWAYS column — never inserted.
        await db.insert(schema.entityAliases).values({
          workspaceId: ws,
          entityId: entity.id,
          alias: "Acme",
        });

        const memoryRows = await db
          .insert(schema.memories)
          .values([
            {
              workspaceId: ws,
              content: `${MARK[ws]} memory: Acme Corp project phoenix status update one`,
              type: "fact",
              sourceChannelType: "public_channel",
              relatedUserIds: [OVERLAP_USER],
              embedding: unitVec(hot),
              shareable: 1,
            },
            {
              workspaceId: ws,
              content: `${MARK[ws]} memory: phoenix launch decision two`,
              type: "decision",
              sourceChannelType: "public_channel",
              relatedUserIds: [OVERLAP_USER],
              embedding: unitVec(hot),
              shareable: 1,
            },
          ])
          .returning({ id: schema.memories.id });

        await db.insert(schema.memoryEntities).values(
          memoryRows.map((m) => ({
            workspaceId: ws,
            memoryId: m.id,
            entityId: entity.id,
          })),
        );

        await db.insert(schema.messages).values([
          {
            workspaceId: ws,
            externalId: `${ws}-thread-msg-1`,
            slackTs: SHARED_THREAD_TS,
            slackThreadTs: SHARED_THREAD_TS,
            channelId: SHARED_CHANNEL,
            channelType: "public_channel",
            userId: OVERLAP_USER,
            role: "user",
            content: `${MARK[ws]} thread root message`,
          },
          {
            workspaceId: ws,
            externalId: `${ws}-thread-msg-2`,
            slackTs: "1700000001.000200",
            slackThreadTs: SHARED_THREAD_TS,
            channelId: SHARED_CHANNEL,
            channelType: "public_channel",
            userId: OVERLAP_USER,
            role: "assistant",
            content: `${MARK[ws]} thread reply`,
          },
        ]);

        const [trace] = await db
          .insert(schema.conversationTraces)
          .values({
            workspaceId: ws,
            sourceType: "interactive",
            source: "slack",
            channelId: `C-${MARK[ws]}`,
            threadTs: SHARED_THREAD_TS,
            userId: OVERLAP_USER,
          })
          .returning({ id: schema.conversationTraces.id });

        await db.insert(schema.conversationMessages).values({
          workspaceId: ws,
          conversationId: trace.id,
          role: "user",
          content: `${MARK[ws]} conversation message`,
          orderIndex: 0,
        });
      });
    }
  }, 120_000);

  afterAll(async () => {
    await rawClient?.end();
  });

  // ── Role shape (must hold BEFORE any isolation claim means anything) ─────

  it("runs as a non-bypassing, non-superuser, non-owner role — the shape production must have", async () => {
    const shape = await rawClient.query(
      "SELECT current_user::text AS role, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    expect(shape.rows[0].rolbypassrls).toBe(false);
    expect(shape.rows[0].rolsuper).toBe(false);
    const owner = await rawClient.query(
      "SELECT pg_get_userbyid(relowner)::text AS owner FROM pg_class WHERE oid = 'public.messages'::regclass",
    );
    expect(owner.rows[0].owner).not.toBe(shape.rows[0].role);
  });

  it("every public table outside the global allowlist has workspace_id + FORCE RLS + both policies", async () => {
    // This is the check that stops the next table from being forgotten
    // (approval_items was absent from the first cut of 0090/0091). Global
    // allowlist: the tenant registry and the public content index. The
    // drizzle ledger lives in the `drizzle` schema, so `public` is exhaustive.
    const GLOBAL_ALLOWLIST = new Set(["workspaces", "content"]);
    const tables = (
      await rawClient.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      )
    ).rows.map((r: { tablename: string }) => r.tablename);
    expect(tables.length).toBeGreaterThan(35);

    const problems: string[] = [];
    for (const table of tables) {
      if (GLOBAL_ALLOWLIST.has(table)) continue;
      const col = await rawClient.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'workspace_id'",
        [table],
      );
      if (col.rowCount === 0) problems.push(`${table}: missing workspace_id column`);

      const rls = await rawClient.query(
        "SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1",
        [table],
      );
      if (!rls.rows[0]?.relrowsecurity) problems.push(`${table}: RLS not enabled`);
      if (!rls.rows[0]?.relforcerowsecurity) problems.push(`${table}: RLS not forced`);

      const policies = await rawClient.query(
        "SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname",
        [table],
      );
      const names = policies.rows.map((r: { policyname: string }) => r.policyname);
      if (!names.includes(`${table}_workspace_isolation`)) {
        problems.push(`${table}: missing ${table}_workspace_isolation policy`);
      }
      if (!names.includes(`${table}_maintenance`)) {
        problems.push(`${table}: missing ${table}_maintenance policy`);
      }
    }
    expect(problems).toEqual([]);
  });

  // ── Guard ────────────────────────────────────────────────────────────────

  it("rejects empty / missing workspace ids", async () => {
    await expect(withWorkspace("", async () => {})).rejects.toThrow(/non-empty/);
    await expect(withWorkspace("   ", async () => {})).rejects.toThrow(/non-empty/);
    await expect(
      withWorkspace(undefined as unknown as string, async () => {}),
    ).rejects.toThrow(/non-empty/);
  });

  // ── Deny by default ──────────────────────────────────────────────────────

  it("denies all access on a connection with no workspace context", async () => {
    const memories = await rawClient.query("SELECT count(*)::int AS n FROM memories");
    expect(memories.rows[0].n).toBe(0);
    const notes = await rawClient.query("SELECT count(*)::int AS n FROM notes");
    expect(notes.rows[0].n).toBe(0);

    await expect(
      rawClient.query(
        `INSERT INTO notes (workspace_id, topic, content) VALUES ('ws-a', 'sneaky', 'x')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("the documented maintenance GUC restores cross-tenant access for operator sessions", async () => {
    await rawClient.query("SELECT set_config('app.rls_bypass', 'maintenance', false)");
    const memories = await rawClient.query("SELECT count(*)::int AS n FROM memories");
    expect(memories.rows[0].n).toBe(4); // 2 per workspace
    await rawClient.query("RESET app.rls_bypass");
    const after = await rawClient.query("SELECT count(*)::int AS n FROM memories");
    expect(after.rows[0].n).toBe(0);
  });

  it("rejects writes tagged for another workspace (WITH CHECK)", async () => {
    let thrown: unknown;
    try {
      await withWorkspace(WS_A, (db) =>
        db.insert(schema.notes).values({
          workspaceId: WS_B,
          topic: "cross-tenant-write",
          content: "should never land",
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeTruthy();
    // Drizzle wraps the pg error — the RLS violation is in the cause chain.
    const messages = [
      (thrown as Error).message,
      String(((thrown as Error).cause as Error | undefined)?.message ?? ""),
    ].join(" | ");
    expect(messages).toMatch(/row-level security/);

    // And the row must never have landed, in either workspace's view.
    await rawClient.query("SELECT set_config('app.rls_bypass', 'maintenance', false)");
    const check = await rawClient.query(
      "SELECT count(*)::int AS n FROM notes WHERE topic = 'cross-tenant-write'",
    );
    await rawClient.query("RESET app.rls_bypass");
    expect(check.rows[0].n).toBe(0);
  });

  // ── Real read paths ──────────────────────────────────────────────────────

  it("memory retrieval returns zero ws-b rows (scoped call, as production makes it)", async () => {
    const { retrieveMemories } = await import("../memory/retrieve.js");
    const results = await withWorkspace(WS_A, () =>
      retrieveMemories({
        query: "What is the Acme Corp project phoenix status?",
        queryEmbedding: queryVec(),
        currentUserId: OVERLAP_USER,
        workspaceId: WS_A,
        adminMode: true,
        limit: 10,
        rewrite: false,
        abstain: false,
        minRelevanceScore: 0,
      }),
    );
    expect(results.length).toBeGreaterThan(0);
    for (const memory of results) {
      expect(memory.content).toContain(MARK[WS_A]);
      expect(memory.content).not.toContain(MARK[WS_B]);
      expect(memory.workspaceId).toBe(WS_A);
    }
  }, 60_000);

  it("memory retrieval leaks nothing even when the caller forgets workspace scoping (RLS-only)", async () => {
    const { retrieveMemories } = await import("../memory/retrieve.js");
    // workspaceId deliberately omitted — the hybrid vector/full-text lane has
    // no in-code workspace filter in that case. RLS is the only fence.
    const results = await withWorkspace(WS_A, () =>
      retrieveMemories({
        query: "phoenix launch decision",
        queryEmbedding: queryVec(),
        currentUserId: OVERLAP_USER,
        adminMode: true,
        limit: 10,
        rewrite: false,
        abstain: false,
        minRelevanceScore: 0,
      }),
    );
    expect(results.length).toBeGreaterThan(0);
    for (const memory of results) {
      expect(memory.content).toContain(MARK[WS_A]);
      expect(memory.content).not.toContain(MARK[WS_B]);
    }
  }, 60_000);

  it("message history for a thread that exists in both workspaces returns only ws-a rows", async () => {
    const { fetchThreadMessages } = await import("../memory/store.js");
    const rows = await withWorkspace(WS_A, () =>
      fetchThreadMessages({ channelId: SHARED_CHANNEL, threadTs: SHARED_THREAD_TS }),
    );
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.content).toContain(MARK[WS_A]);
      expect(row.content).not.toContain(MARK[WS_B]);
    }
  });

  it("entity resolution resolves ws-a's entity and cannot see ws-b's twin", async () => {
    const { resolveEntityByName } = await import("../memory/entity-resolution.js");
    const [entityA] = await withWorkspace(WS_A, (db) =>
      db.select().from(schema.entities),
    );
    expect(entityA.summary).toContain(MARK[WS_A]);

    const resolved = await withWorkspace(WS_A, () =>
      resolveEntityByName("Acme Corp", WS_A),
    );
    expect(resolved?.entityId).toBe(entityA.id);

    // Even asking for ws-b's entity by id-space (buggy/hostile caller) yields
    // nothing under the ws-a scope: RLS, not the query, is the fence.
    const crossTenant = await withWorkspace(WS_A, () =>
      resolveEntityByName("Acme Corp", WS_B),
    );
    expect(crossTenant).toBeNull();
  });

  it("notes read sees only ws-a's copy of the shared topic", async () => {
    const rows = await withWorkspace(WS_A, (db) => db.select().from(schema.notes));
    expect(rows.length).toBe(1);
    expect(rows[0].topic).toBe("project-phoenix");
    expect(rows[0].content).toContain(MARK[WS_A]);
  });

  it("validity control: the same paths under ws-b see only ws-b rows", async () => {
    const { fetchThreadMessages } = await import("../memory/store.js");
    const rows = await withWorkspace(WS_B, () =>
      fetchThreadMessages({ channelId: SHARED_CHANNEL, threadTs: SHARED_THREAD_TS }),
    );
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.content).toContain(MARK[WS_B]);
    }
    const notesB = await withWorkspace(WS_B, (db) => db.select().from(schema.notes));
    expect(notesB.length).toBe(1);
    expect(notesB[0].content).toContain(MARK[WS_B]);
  });

  // ── Dashboard routes (real Hono app + real middleware wiring) ────────────

  describe("dashboard routes under DEFAULT_WORKSPACE_ID=ws-a", () => {
    let app: typeof import("../app.js").app;
    const headers = { authorization: `Bearer ${process.env.DASHBOARD_API_SECRET}` };

    beforeAll(async () => {
      expect(process.env.DEFAULT_WORKSPACE_ID).toBe(WS_A);
      expect(process.env.DASHBOARD_API_SECRET).toBeTruthy();
      ({ app } = await import("../app.js"));
    });

    it("GET /api/dashboard/conversations returns zero ws-b rows", async () => {
      const res = await app.request("/api/dashboard/conversations", { headers });
      expect(res.status).toBe(200);
      const body = await res.json();
      const text = JSON.stringify(body);
      expect(body.total).toBe(1);
      expect(text).toContain(MARK[WS_A]);
      expect(text).not.toContain(MARK[WS_B]);
    });

    it("GET /api/dashboard/stats counts only ws-a rows", async () => {
      const res = await app.request("/api/dashboard/stats", { headers });
      expect(res.status).toBe(200);
      const body = await res.json();
      // The stats queries have NO workspace filter in code — these counts
      // being ws-a-only is pure RLS.
      expect(body.notes).toBe(1);
      expect(body.memories).toBe(2);
      expect(body.users).toBe(1);
    });

    it("GET /api/dashboard/entities returns zero ws-b rows", async () => {
      const res = await app.request("/api/dashboard/entities", { headers });
      expect(res.status).toBe(200);
      const text = JSON.stringify(await res.json());
      expect(text).toContain("Acme Corp");
      expect(text).not.toContain(MARK[WS_B]);
    });

    it("GET /api/dashboard/notes returns zero ws-b rows", async () => {
      const res = await app.request("/api/dashboard/notes", { headers });
      expect(res.status).toBe(200);
      const text = JSON.stringify(await res.json());
      expect(text).toContain(MARK[WS_A]);
      expect(text).not.toContain(MARK[WS_B]);
    });
  });
});

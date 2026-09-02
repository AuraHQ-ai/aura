import { sql } from "drizzle-orm";
import { drizzle as drizzleNeon, type NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "@aura/db/schema";
import { getSessionPool } from "./workspace.js";
import { currentWorkspaceId } from "./workspace-context.js";

/**
 * The transaction client handed to `withTransaction(fn)` — a drizzle
 * transaction scoped to a single pooled connection. Supports the full query
 * builder plus raw `tx.execute(sql\`...\`)`.
 */
export type NeonTx = Parameters<
  Parameters<NeonDatabase<typeof schema>["transaction"]>[0]
>[0];

/**
 * Run `fn` inside a real interactive Postgres transaction.
 *
 * The default `db` client (`apps/api/src/db/client.ts`) uses Neon's HTTP
 * driver, which is ideal for one-shot queries but cannot run interactive
 * transactions — `db.transaction()` throws "No transactions support in
 * neon-http driver". For the handful of operations that need atomic
 * multi-statement writes (memory supersession/consolidation, entity merges,
 * dashboard auth bootstrap) we run the transaction on the shared
 * session-capable pool from workspace.ts (neon WebSocket Pool on Neon hosts,
 * node-postgres locally — same driver selection as withWorkspace()).
 *
 * Multi-tenancy (issue #1393): when called inside a withWorkspace() scope,
 * the ambient workspace id is applied with `SET LOCAL app.workspace_id`
 * right after BEGIN, so the RLS policies (migration 0091) scope every
 * statement of the transaction — correct through the Neon `-pooler` host,
 * because PgBouncer pins the backend for the duration of an explicit
 * transaction. Outside any scope, no GUC is set and RLS fails closed under
 * the non-bypassing `aura_app` role (migration 0092).
 */
export async function withTransaction<T>(
  fn: (tx: NeonTx) => Promise<T>,
): Promise<T> {
  const { pool, kind } = await getSessionPool();
  const workspaceId = currentWorkspaceId();

  const txDb =
    kind === "neon"
      ? drizzleNeon(pool as never, { schema })
      : ((await import("drizzle-orm/node-postgres")).drizzle(pool as never, {
          schema,
        }) as unknown as NeonDatabase<typeof schema>);

  return txDb.transaction(async (tx) => {
    if (workspaceId) {
      await tx.execute(
        sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`,
      );
    }
    return fn(tx as NeonTx);
  });
}

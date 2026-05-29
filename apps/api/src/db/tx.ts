import { Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "@aura/db/schema";

/**
 * The transaction client handed to `withTransaction(fn)` — a drizzle
 * transaction scoped to a single pooled WebSocket connection. Supports the
 * full query builder plus raw `tx.execute(sql\`...\`)`.
 */
export type NeonTx = Parameters<
  Parameters<NeonDatabase<typeof schema>["transaction"]>[0]
>[0];

// Neon's WebSocket driver needs a WebSocket implementation. Node 21+ and the
// Vercel runtime expose a global `WebSocket`, which @neondatabase/serverless
// picks up automatically — so no `ws` polyfill is required on our runtimes.

/**
 * Run `fn` inside a real interactive Postgres transaction.
 *
 * The default `db` client (`apps/api/src/db/client.ts`) uses Neon's HTTP
 * driver, which is ideal for one-shot queries but cannot run interactive
 * transactions — `db.transaction()` throws "No transactions support in
 * neon-http driver". For the handful of operations that need atomic
 * multi-statement writes (memory supersession/consolidation, entity merges,
 * dashboard auth bootstrap) we open a short-lived pooled WebSocket connection,
 * run the transaction, and tear it down in `finally` so we never leak
 * connections on the serverless/Fluid runtime.
 */
export async function withTransaction<T>(
  fn: (tx: NeonTx) => Promise<T>,
): Promise<T> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const pool = new Pool({ connectionString });
  try {
    const txDb = drizzle(pool, { schema });
    return await txDb.transaction(fn);
  } finally {
    await pool.end();
  }
}

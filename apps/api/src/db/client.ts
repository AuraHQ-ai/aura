import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "@aura/db/schema";
import { workspaceStorage } from "./workspace-context.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

const sql = neon(connectionString);

const baseDb = drizzle(sql, { schema });

export type Database = typeof baseDb;

/**
 * The shared drizzle handle.
 *
 * Outside a withWorkspace() scope this is the stateless neon-http driver,
 * exactly as before. Inside withWorkspace() (see workspace.ts) every property
 * access transparently delegates to the drizzle handle bound to that scope's
 * pinned, workspace-scoped connection — so the ~400 existing call sites that
 * import `db` are RLS-scoped without touching any of them.
 */
export const db: Database = new Proxy(baseDb, {
  get(target, prop) {
    const store = workspaceStorage.getStore();
    const delegate =
      store?.active && store.handle ? (store.handle as Record<PropertyKey, unknown>) : target;
    const value = (delegate as Record<PropertyKey, unknown>)[prop as string];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(delegate) : value;
  },
});

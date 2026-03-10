import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  const sql = neon(url);
  return drizzle(sql);
}

let _db: ReturnType<typeof createDb> | null = null;

export const db = new Proxy({} as ReturnType<typeof createDb>, {
  get(_, prop) {
    if (!_db) _db = createDb();
    return (_db as any)[prop];
  },
});

/**
 * Programmatic migration runner.
 *
 * Used by the Vercel build step to apply pending migrations on every deploy.
 * Drizzle tracks applied migrations in a `__drizzle_migrations` journal table,
 * so this is idempotent -- running it when there's nothing new is a no-op.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("DATABASE_URL is not set -- skipping migrations");
  process.exit(0);
}

const sql = neon(connectionString);
const db = drizzle(sql);

console.log("Running database migrations...");

try {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");
} catch (error) {
  console.error("Migration failed:", error);
  process.exit(1);
}

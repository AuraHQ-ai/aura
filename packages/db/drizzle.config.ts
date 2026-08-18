import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // unix prefix names new migrations by epoch (e.g. 1786996239_my_migration.sql)
  // instead of an incrementing index, preventing `when` collisions on parallel branches.
  migrations: {
    prefix: "unix",
  },
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});

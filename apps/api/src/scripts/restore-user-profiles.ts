/**
 * Restore user profile data from the dev (local) DB to prod.
 *
 * Copies curated fields that aren't auto-generated:
 *   role, job_title, gender, preferred_language, birthdate,
 *   manager_id, notes, communication_style, known_facts
 *
 * Usage:
 *   pnpx tsx apps/api/src/scripts/restore-user-profiles.ts          # dry run
 *   pnpx tsx apps/api/src/scripts/restore-user-profiles.ts --apply  # write to prod
 *
 * Always reads .env.local (source) and .env.production (target).
 * Matches users by slack_user_id across both databases.
 */
import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");

const localEnv: Record<string, string> = {};
const prodEnv: Record<string, string> = {};
config({ path: resolve(repoRoot, ".env.local"), processEnv: localEnv });
config({ path: resolve(repoRoot, ".env.production"), processEnv: prodEnv });

const localDbUrl = localEnv.DATABASE_URL;
const prodDbUrl = prodEnv.DATABASE_URL;

if (!localDbUrl) { console.error("Missing DATABASE_URL in .env.local"); process.exit(1); }
if (!prodDbUrl) { console.error("Missing DATABASE_URL in .env.production"); process.exit(1); }
if (localDbUrl === prodDbUrl) { console.error("Source and target DATABASE_URL are the same — aborting."); process.exit(1); }

const apply = process.argv.includes("--apply");

// Same driver as db/client.ts — neon HTTP + drizzle
const sourceDb = drizzle(neon(localDbUrl));
const targetDb = drizzle(neon(prodDbUrl));

type ResultRow = Record<string, unknown>;
function extractRows(result: unknown): ResultRow[] {
  return ((result as any).rows ?? result) as ResultRow[];
}

const PROFILE_FIELDS = [
  "role",
  "job_title",
  "gender",
  "preferred_language",
  "birthdate",
  "manager_id",
  "notes",
  "communication_style",
  "known_facts",
] as const;

async function main() {
  console.log(`=== Restore User Profiles (dev → prod) ===`);
  console.log(`Mode: ${apply ? "APPLY (writing to prod)" : "DRY RUN (pass --apply to write)"}\n`);

  const sourceUsers = extractRows(
    await sourceDb.execute(sql`
      SELECT workspace_id, slack_user_id, display_name, timezone,
             role, job_title, gender, preferred_language, birthdate,
             manager_id, notes, communication_style, known_facts
      FROM users
      WHERE slack_user_id IS NOT NULL
    `),
  );
  console.log(`Source (dev): ${sourceUsers.length} users with slack_user_id`);

  const targetUsers = extractRows(
    await targetDb.execute(sql`
      SELECT slack_user_id, role, job_title, gender, preferred_language,
             birthdate, manager_id, notes, communication_style, known_facts
      FROM users
      WHERE slack_user_id IS NOT NULL
    `),
  );
  const targetMap = new Map(targetUsers.map((u) => [u.slack_user_id as string, u]));
  console.log(`Target (prod): ${targetUsers.length} users with slack_user_id\n`);

  let updated = 0;
  let created = 0;
  let skipped = 0;

  for (const src of sourceUsers) {
    const slackId = src.slack_user_id as string;
    const target = targetMap.get(slackId);

    if (!target) {
      console.log(`+ ${src.display_name} (${slackId}) — missing in prod`);
      if (apply) {
        const sqlVal = (v: unknown) => {
          if (v === null || v === undefined) return sql`NULL`;
          if (v instanceof Date) return sql`${v.toISOString()}`;
          if (typeof v === "object") return sql`${JSON.stringify(v)}::jsonb`;
          return sql`${String(v)}`;
        };
        const vals = [
          src.workspace_id, src.slack_user_id, src.display_name, src.timezone,
          src.role, src.job_title, src.gender, src.preferred_language, src.birthdate,
          src.manager_id, src.notes, src.communication_style, src.known_facts,
        ].map(sqlVal);
        await targetDb.execute(sql`
          INSERT INTO users (workspace_id, slack_user_id, display_name, timezone,
            role, job_title, gender, preferred_language, birthdate,
            manager_id, notes, communication_style, known_facts)
          VALUES (${sql.join(vals, sql.raw(", "))})
        `);
      }
      created++;
      continue;
    }

    const changes: Record<string, unknown> = {};
    for (const field of PROFILE_FIELDS) {
      const srcVal = JSON.stringify(src[field] ?? null);
      const tgtVal = JSON.stringify(target[field] ?? null);
      if (srcVal !== tgtVal) {
        changes[field] = src[field];
      }
    }

    if (Object.keys(changes).length === 0) {
      skipped++;
      continue;
    }

    console.log(`${src.display_name} (${slackId}):`);
    for (const [field, value] of Object.entries(changes)) {
      const displayVal = typeof value === "object" ? JSON.stringify(value) : String(value ?? "null");
      const truncated = displayVal.length > 80 ? displayVal.slice(0, 77) + "..." : displayVal;
      console.log(`  ${field}: ${truncated}`);
    }

    if (apply) {
      const setClauses = Object.entries(changes).map(([field, value]) => {
        if (value === null || value === undefined) {
          return sql`${sql.raw(field)} = NULL`;
        }
        if (value instanceof Date) {
          return sql`${sql.raw(field)} = ${value.toISOString()}`;
        }
        if (typeof value === "object") {
          return sql`${sql.raw(field)} = ${JSON.stringify(value)}::jsonb`;
        }
        return sql`${sql.raw(field)} = ${String(value)}`;
      });

      await targetDb.execute(
        sql`UPDATE users SET ${sql.join(setClauses, sql.raw(", "))}, updated_at = now() WHERE slack_user_id = ${slackId}`,
      );
    }
    updated++;
  }

  console.log(`\nSummary:`);
  console.log(`  Created:     ${created}`);
  console.log(`  Updated:     ${updated}`);
  console.log(`  Unchanged:   ${skipped}`);

  if (!apply && (updated > 0 || created > 0)) {
    console.log(`\nThis was a dry run. Run with --apply to write changes to prod.`);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

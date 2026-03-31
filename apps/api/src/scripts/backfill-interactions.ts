import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const isProd = process.argv.includes("--prod");
const envFile = isProd ? ".env.production" : ".env.local";
config({ path: resolve(repoRoot, envFile) });
if (isProd) console.log("Using .env.production (--prod)");

const { db } = await import("../db/client.js");

type ResultRow = Record<string, unknown>;
function extractRows(result: unknown): ResultRow[] {
  return ((result as any).rows ?? result) as ResultRow[];
}

async function main() {
  console.log("=== Backfill Interaction Counts ===\n");

  const beforeRows = extractRows(
    await db.execute(sql`
      SELECT count(*)::int AS total_users,
             sum(interaction_count)::int AS total_interactions,
             count(*) FILTER (WHERE interaction_count > 0)::int AS users_with_interactions
      FROM users
    `),
  );
  const before = beforeRows[0];
  console.log("Before:");
  console.log(`  Total users:              ${before.total_users}`);
  console.log(`  Users with interactions:  ${before.users_with_interactions}`);
  console.log(`  Total interaction count:  ${before.total_interactions}`);
  console.log();

  // Rebuild interaction_count and last_interaction_at from messages table.
  // Only counts role='user' messages (what the live incrementInteractionCount does).
  const updateRows = extractRows(
    await db.execute(sql`
      WITH counts AS (
        SELECT user_id,
               count(*)::int AS cnt,
               max(created_at) AS last_at
        FROM messages
        WHERE role = 'user'
        GROUP BY user_id
      )
      UPDATE users
      SET interaction_count = counts.cnt,
          last_interaction_at = counts.last_at,
          updated_at = now()
      FROM counts
      WHERE users.slack_user_id = counts.user_id
      RETURNING users.slack_user_id
    `),
  );
  console.log(`Updated ${updateRows.length} users from message history`);

  // Zero out users with no messages (in case they had stale counts)
  const zeroRows = extractRows(
    await db.execute(sql`
      UPDATE users
      SET interaction_count = 0,
          last_interaction_at = NULL,
          updated_at = now()
      WHERE slack_user_id NOT IN (
        SELECT DISTINCT user_id FROM messages WHERE role = 'user'
      )
      AND interaction_count > 0
      RETURNING slack_user_id
    `),
  );
  if (zeroRows.length > 0) {
    console.log(`Zeroed out ${zeroRows.length} users with no messages`);
  }

  const afterRows = extractRows(
    await db.execute(sql`
      SELECT count(*)::int AS total_users,
             sum(interaction_count)::int AS total_interactions,
             count(*) FILTER (WHERE interaction_count > 0)::int AS users_with_interactions
      FROM users
    `),
  );
  const after = afterRows[0];
  console.log("\nAfter:");
  console.log(`  Total users:              ${after.total_users}`);
  console.log(`  Users with interactions:  ${after.users_with_interactions}`);
  console.log(`  Total interaction count:  ${after.total_interactions}`);
  console.log("\nInteraction backfill complete.");
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

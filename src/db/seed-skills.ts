/**
 * Seed initial skill notes.
 *
 * Run after migration to bootstrap Aura's core playbooks.
 * Idempotent: only inserts skills that don't already exist.
 *
 * Usage: tsx src/db/seed-skills.ts
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { notes } from "./schema.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("DATABASE_URL is not set — skipping skill seeding");
  process.exit(0);
}

const sql = neon(connectionString);
const db = drizzle(sql);

const SEED_SKILLS = [
  {
    topic: "self-code-review",
    category: "skill",
    content: `# How to read and modify your own source code

1. Clone the repo (once per sandbox session):
   run_command("git clone https://$GITHUB_TOKEN@github.com/realadvisor/aura.git /home/user/aura")

2. Search for code:
   run_command("rg 'pattern' /home/user/aura/src/")

3. Read files:
   run_command("cat /home/user/aura/src/path/to/file.ts")

4. For changes: create a branch, make edits, commit, push, open PR via gh CLI.
   Always create PRs on branches, never push to main.
   Tag Joan for review on anything non-trivial.
   For prompt changes (system-prompt.ts): flag as "self-edit" and explain reasoning.`,
  },
  {
    topic: "follow-up-protocol",
    category: "skill",
    content: `# How to follow up with someone over multiple days

1. DM the person with the request.
2. Save a plan note ("follow-up-{person}-{topic}") with context: what you asked,
   who asked you, deadline, escalation contact.
3. Create a follow-up job with create_job: execute_in "4 hours", description:
   "Check if {person} replied via read_dm_history. If yes, report to {requester}.
   If no, send gentle nudge. If 3 days passed, escalate to {requester}."
4. On each check: if no reply, create another follow-up job with escalating
   intervals (4h, 12h, 24h).`,
  },
  {
    topic: "continuation-protocol",
    category: "skill",
    content: `# How to handle tasks that exceed your step limit

You have up to 350 tool calls per job execution. This is enough for most tasks.

1. Plan before you act. For ambitious work, sketch your approach first.
2. Be efficient with tool calls -- batch reads, avoid redundant lookups.
3. If you can't finish within your step budget:
   - Post a summary of what's done and what remains.
   - Create a follow-up job (create_job) with a clear description of the next steps.
   - The heartbeat will pick it up in the next cycle (~30 min).
4. For multi-day workflows (follow-ups, campaigns), use scheduled jobs with
   appropriate delays rather than trying to do everything in one execution.`,
  },
];

console.log("Seeding initial skill notes...");

try {
  for (const skill of SEED_SKILLS) {
    await db
      .insert(notes)
      .values({
        topic: skill.topic,
        content: skill.content,
        category: skill.category,
        updatedAt: new Date(),
      })
      .onConflictDoNothing();

    console.log(`  - ${skill.topic}: seeded (or already exists)`);
  }
  console.log("Skill seeding complete.");
} catch (error) {
  console.error("Skill seeding failed:", error);
  process.exit(1);
}

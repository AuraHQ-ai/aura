# Aura - AI Agent for RealAdvisor

## What this is
Aura is an autonomous AI agent that operates as a team member inside RealAdvisor's Slack workspace. It handles bug triage, data analysis, team coordination, and self-improvement.

## Monorepo structure
This is a pnpm workspace monorepo. Run `pnpm install` at the root.

- `packages/db/` — shared database package (`@aura/db`): Drizzle schema, migrations, migration runner
- `apps/api/` — Hono API deployed on Vercel (Slack bot, cron jobs, tools)
- `apps/dashboard/` — Next.js admin dashboard
- `apps/web/` — marketing site / blog
- `content/` — blog posts and Mintlify documentation

## Tech stack
- **Runtime:** Vercel serverless functions (Node.js, TypeScript)
- **Framework:** Hono for HTTP routing (API), Next.js (dashboard)
- **AI:** Vercel AI SDK with Anthropic Claude models (via AI Gateway)
- **Database:** PostgreSQL with Drizzle ORM + pgvector for embeddings
- **Integrations:** Slack API (Bot + User tokens), GitHub, BigQuery, Google Workspace (Gmail, Calendar, Directory), SendGrid
- **Sandbox:** e2b sandboxed Linux VM for code execution

## Key directories
- `packages/db/src/schema.ts` — single source of truth for database schema
- `packages/db/drizzle/` — database migrations
- `packages/db/drizzle.config.ts` — Drizzle Kit configuration
- `apps/api/src/` — API source code
- `apps/api/src/tools/` — Slack, BigQuery, notes, jobs, email, calendar, canvas, sandbox tools
- `apps/api/src/lib/` — shared libraries (Slack client, Gmail, temporal, formatting)
- `apps/api/src/db/client.ts` — database client (imports schema from `@aura/db`)
- `apps/dashboard/src/` — dashboard source code

## Database workflow
```bash
pnpm db:generate    # generate migrations from schema changes
pnpm db:migrate     # apply pending migrations
pnpm db:push        # push schema directly (dev only)
pnpm db:studio      # open Drizzle Studio
```

## Conventions
- TypeScript strict mode
- All tool functions return `{ ok: true, ... }` or `{ ok: false, error: "..." }`
- Slack message formatting uses mrkdwn (not markdown)
- ISO 8601 timestamps in user's timezone throughout
- Environment variables configured in Vercel, some injected into sandbox at runtime
- Import schema types via `import { ... } from "@aura/db/schema"`

## Tool documentation convention
- Tool `description` fields are the **primary source** of "when/how to use" guidance for the LLM
- The system prompt contains only **cross-cutting behavioral rules** (e.g. DM privacy, channel access), NOT per-tool documentation
- When adding a new tool, put all usage guidance in the tool's `description` field, not the system prompt

## Common pitfalls
- Slack's `chat.update` has a 40K character limit — messages get truncated
- pgvector columns must all use the same dimensions (1536)
- The sandbox (e2b) is a separate environment from Vercel — env vars don't automatically cross over
- Schema lives in `packages/db/` — both apps import from `@aura/db/schema`

## Drizzle migration rules (CRITICAL)
- **Every SQL migration file with multiple statements MUST have `--> statement-breakpoint` appended to the END of each statement line (same line, not a separate line).**
- The journal has `breakpoints: true`, so Drizzle uses these markers to split the file into individual SQL commands.
- Without the markers, Drizzle concatenates all statements into one string, and Postgres rejects multi-statement execution.
- Example of a correct multi-statement migration:
```sql
ALTER TABLE "notes" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "inject_in_context" boolean NOT NULL DEFAULT false;--> statement-breakpoint
UPDATE "notes" SET "inject_in_context" = true WHERE "category" = 'skill';
```
- Single-statement migrations (one CREATE TABLE, one ALTER TABLE) do NOT need the marker.
- **This is the #1 cause of failed Vercel builds.** Always check migration files before committing.

# Aura - AI Agent for RealAdvisor

## What this is
Aura is an autonomous AI agent that operates as a team member inside RealAdvisor's Slack workspace. It handles bug triage, data analysis, team coordination, and self-improvement.

## Monorepo structure
This is a pnpm workspace monorepo. Run `pnpm install` at the root.

- `packages/db/` — shared database package (`@aura/db`): Drizzle schema, migrations, migration runner
- `apps/api/` — Hono API deployed on Vercel (Slack bot, cron jobs, tools)
- `apps/dashboard/` — Vite + TanStack Router admin dashboard
- `apps/web/` — marketing site / blog
- `content/` — blog posts and Mintlify documentation

## Tech stack
- **Runtime:** Vercel serverless functions (Node.js, TypeScript)
- **Framework:** Hono for HTTP routing (API), Vite + TanStack Router (dashboard)
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
pnpm db:generate            # generate migrations from schema changes
pnpm db:migrate             # apply pending migrations (uses .env.local)
pnpm db:migrate --prod      # apply pending migrations against production DB
pnpm db:push                # push schema directly (dev only)
pnpm db:studio              # open Drizzle Studio
```

All `db:*` scripts use `./scripts/env.sh` which loads `.env.local` by default. Pass `--prod` to use `.env.production`.

## Environment variables
- **`.env.local`** at repo root — all local development env vars (gitignored)
- **`.env.production`** at repo root — production credentials, opt-in via `--prod` (gitignored)
- **`.env.example`** — committed template documenting all variables
- No per-app `.env` files. No plain `.env` file.
- Production env vars managed via Vercel CLI, some injected into sandbox at runtime

## Conventions
- TypeScript strict mode
- All tool functions return `{ ok: true, ... }` or `{ ok: false, error: "..." }`
- Slack message formatting uses mrkdwn (not markdown)
- ISO 8601 timestamps in user's timezone throughout
- Import schema types via `import { ... } from "@aura/db/schema"`

## Tool documentation convention
- Tool `description` fields are the **primary source** of "when/how to use" guidance for the LLM
- The system prompt contains only **cross-cutting behavioral rules** (e.g. DM privacy, channel access), NOT per-tool documentation
- When adding a new tool, put all usage guidance in the tool's `description` field, not the system prompt

## Pre-push checks
- A husky pre-push hook runs `pnpm typecheck` automatically (type-checks both `apps/api` and `apps/dashboard`).
- Always run `pnpm typecheck` at the monorepo root before committing. Never commit code that breaks `tsc --noEmit`.
- The Vercel build will reject type errors, so catching them locally saves a deploy cycle.

## Common pitfalls
- Slack's `chat.update` has a 40K character limit — messages get truncated
- pgvector columns must all use the same dimensions (1536)
- The sandbox (e2b) is a separate environment from Vercel — env vars don't automatically cross over
- Schema lives in `packages/db/` — both apps import from `@aura/db/schema`

## Architecture: API-Only Dashboard
- The dashboard (`apps/dashboard`) is a **pure client** of the API — it MUST NOT hold `DATABASE_URL`, import `drizzle-orm` for queries, or access Postgres directly
- All data flows through the Hono API at `/api/dashboard/*`, authenticated with `DASHBOARD_API_SECRET`
- Dashboard server actions are thin `fetch()` wrappers using `apps/dashboard/src/lib/api.ts`
- API routes live in `apps/api/src/routes/dashboard/` with shared auth middleware in `index.ts`
- When adding a new dashboard feature, add an API endpoint first, then call it from the dashboard

## Memory changes (run the bench)
- Changes to `apps/api/src/memory/**`, `apps/api/bench/**`, the system/core prompts, or the DB schema can move memory quality — validate with the memory bench, not just `pnpm typecheck`. See the `aura-memory-bench` skill + rule.
- It's **local-first** (no PR run). Record results with `--log` (appends `apps/api/bench/history.jsonl`, regenerates `apps/api/bench/README.md` + the root README snapshot) and commit those with the change.
- **Cost/runtime gate**: a full run (~2,486 questions) takes ~2–3 hours and costs real money; medium (~330 Qs) is ~1 hour / ~$10. NEVER block a turn on a run (no `| tail`/`| tee`). Run cheap smoke/fast subsets yourself as background jobs; for medium/full runs, hand the user the command and ask them to run it.

## Multi-Channel LLM Pipeline
- All LLM responses go through `createAgenticStream()` in `apps/api/src/pipeline/generate.ts`
- This applies `prepareStep` middleware (thinking, effort, escalation, pruning) uniformly across channels
- Channel connectors handle delivery only — NEVER configure model behavior (providerOptions, thinking) in connector code
- New channels must use `createAgenticStream()`, not raw `streamText()`

## Durable Execution (Vercel Workflow DevKit)
- The API is built with **Nitro** (`apps/api/nitro.config.ts`) so the Workflow DevKit can compile `"use workflow"` / `"use step"` directives. Workflows live in `apps/api/workflows/`.
- **Dashboard chat** runs as one workflow run per turn (`workflows/dashboard-chat.ts`): the server owns the generation, the browser is just a reader. Streams are resumable via `GET /api/dashboard/chat/runs/:runId/stream`; the `dashboard_chat_runs` table maps threads ↔ runs. A client disconnect must NEVER cancel generation — explicit stop goes through `POST /api/dashboard/chat/runs/:runId/cancel`.
- **Slack respond** has a flag-gated durable path (`workflows/slack-respond.ts`, enabled via `AURA_WDK_SLACK_RESPOND` or the `wdk_slack_respond` setting): one step per model-call + Slack-append cycle, so a SIGKILL resumes the turn instead of killing it. The legacy in-process path in `respond.ts` is still the default.
- Step inputs/outputs must be **serializable** (no zod schemas, model instances, or clients across the step boundary — rebuild them inside steps).
- Local dev: `nitro dev` runs workflows against the Local World (`.workflow-data/`). Inspect with `npx workflow inspect runs` / `npx workflow web`. On Vercel, runs use the managed Vercel World (queue-triggered functions emitted by the build).

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

## Multi-tenancy: workspace_id on every table (CRITICAL)
Every table MUST include a `workspace_id` column using the `workspaceId()` helper from `packages/db/src/schema.ts`. This enables multi-workspace tenant isolation.

- Use `workspaceId: workspaceId().references(() => workspaces.id)` on every new table
- Unique constraints must be composite with `workspace_id` (e.g. `uniqueIndex("my_table_workspace_name_idx").on(table.workspaceId, table.name)`)
- The `workspaces` table itself is the only exception
- Never create a table without `workspace_id` -- it will break multi-tenant isolation and require a migration to fix later

# Aura - AI Agent for RealAdvisor

## What this is
Aura is an autonomous AI agent that operates as a team member inside RealAdvisor's Slack workspace. It handles bug triage, data analysis, team coordination, and self-improvement.

## Tech stack
- **Runtime:** Vercel serverless functions (Node.js, TypeScript)
- **Framework:** Hono for HTTP routing
- **AI:** Vercel AI SDK with Anthropic Claude models (via AI Gateway)
- **Database:** PostgreSQL with Drizzle ORM + pgvector for embeddings
- **Integrations:** Slack API (Bot + User tokens), GitHub, BigQuery, Google Workspace (Gmail, Calendar, Directory), SendGrid
- **Sandbox:** e2b sandboxed Linux VM for code execution

## Key directories
- `src/` — all source code
- `src/tools/` — Slack, BigQuery, notes, jobs, email, calendar, canvas, sandbox tools
- `src/lib/` — shared libraries (Slack client, Gmail, temporal, formatting)
- `src/db/` — Drizzle schema and database access
- `drizzle/` — database migrations

## Conventions
- TypeScript strict mode
- All tool functions return `{ ok: true, ... }` or `{ ok: false, error: "..." }`
- Slack message formatting uses mrkdwn (not markdown)
- ISO 8601 timestamps in user's timezone throughout
- Environment variables configured in Vercel, some injected into sandbox at runtime

## Common pitfalls
- Slack's `chat.update` has a 40K character limit — messages get truncated
- pgvector columns must all use the same dimensions (1536)
- The sandbox (e2b) is a separate environment from Vercel — env vars don't automatically cross over
- Drizzle migrations must be applied manually after schema changes

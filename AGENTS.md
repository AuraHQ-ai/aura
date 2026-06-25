# AGENTS.md

General project conventions and architecture are documented in `CLAUDE.md` at the repo root. Read that first.

## Cursor Cloud specific instructions

### Running services locally

- **API**: `cd apps/api && pnpm dev` — runs `nitro dev` (loads `../../.env.local`, port from `PORT`, default 3001). Nitro is required for the Workflow DevKit (`"use workflow"` / `"use step"`) to compile; workflows run against the Local World (`.workflow-data/`, gitignored).
- **API without workflows**: `cd apps/api && pnpm dev:node` (legacy tsx watcher — durable chat/respond paths can't start workflow runs under it).
- **Dashboard**: `cd apps/dashboard && pnpm dev` (Vite dev server on port 5173, proxies `/api` to localhost:3001)
- **Both together**: `pnpm dev` from repo root (builds `@aura/db` first, then starts both in parallel)

### Environment setup gotchas

- `ELEVENLABS_API_KEY` must be set (even as a placeholder) because the ElevenLabs client is instantiated at module load time in `apps/api/src/webhook/elevenlabs.ts` — without it the API crashes on startup.
- `DATABASE_URL` is required for the API to start. The Neon serverless driver connects lazily (server starts even with an invalid URL), but DB queries will fail without a real connection string.
- The `lint` script in `apps/api` references `eslint` but it is not installed as a dependency. Use `pnpm typecheck` as the primary code quality check (enforced by the pre-push hook).
- `pnpm install` warnings about ignored build scripts (esbuild, sharp) are safe to ignore — these packages are approved via `pnpm.onlyBuiltDependencies` in root `package.json`.
- `@aura/db` must be built before running apps — it exports compiled JS from `dist/`. Run `pnpm --filter @aura/db build` (or `pnpm dev` which does it automatically).
- The dashboard uses `vite-plus` (alias `vp`) as the dev/build CLI, not raw `vite`.

### Verification commands

```bash
pnpm typecheck                # Type-check API + Dashboard (run before committing)
pnpm --filter aura-api test   # Run API unit/integration tests (vitest, no DB needed)
curl http://localhost:3001/    # API health: {"name":"Aura","version":"0.1.0","status":"alive"}
```

### Notes

- The dashboard requires Slack OAuth login. To test authenticated dashboard API routes directly, use `Authorization: Bearer $DASHBOARD_API_SECRET` header. For local browser testing without Slack OAuth, generate a JWT signed with `DASHBOARD_SESSION_SECRET` containing `{ slackUserId, name, picture }` and pass it as `?token=<jwt>` in the URL.
- All optional integrations (E2B, Tavily, GitHub, ElevenLabs, Twilio, etc.) degrade gracefully when env vars are missing — they disable features rather than crash.
- `.env.local` at the repo root is the single env file for local dev (gitignored). Copy from `.env.example` and fill in real values as needed.
- Durable execution (Vercel Workflow DevKit): dashboard chat always runs as a workflow (`apps/api/workflows/dashboard-chat.ts`); the Slack respond workflow (`apps/api/workflows/slack-respond.ts`) is gated behind `AURA_WDK_SLACK_RESPOND` / the `wdk_slack_respond` setting. Inspect local runs with `npx workflow inspect runs` or `npx workflow web` from `apps/api`.

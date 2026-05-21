# AGENTS.md

General project conventions and architecture are documented in `CLAUDE.md` at the repo root. Read that first.

## Cursor Cloud specific instructions

### Running services locally

- **API**: `cd apps/api && node --env-file=../../.env.local --import tsx --watch src/index.ts` (port 3001)
- **Dashboard**: `cd apps/dashboard && pnpm dev` (Vite dev server on port 5173, proxies `/api` to localhost:3001)
- **Both together**: `pnpm dev` from repo root (builds `@aura/db` first, then starts both in parallel)

### Environment setup gotchas

- `ELEVENLABS_API_KEY` must be set (even as a placeholder) because the ElevenLabs client is instantiated at module load time in `apps/api/src/webhook/elevenlabs.ts` — without it the API crashes on startup.
- `DATABASE_URL` is required for the API to start. The Neon serverless driver connects lazily (server starts even with an invalid URL), but DB queries will fail without a real connection string.
- The `lint` script in `apps/api` references `eslint` but it is not installed as a dependency. Use `pnpm typecheck` as the primary code quality check (enforced by the pre-push hook).
- `pnpm install` warnings about ignored build scripts (esbuild, sharp) are safe to ignore — these packages use prebuilt platform binaries.

### Verification commands

```bash
pnpm typecheck                # Type-check API + Dashboard (run before committing)
pnpm --filter aura-api test   # Run API unit/integration tests (vitest)
curl http://localhost:3001/    # API health: {"name":"Aura","version":"0.1.0","status":"alive"}
```

### Notes

- The dashboard requires Slack OAuth login. To test authenticated dashboard API routes directly, use `Authorization: Bearer $DASHBOARD_API_SECRET` header.
- All optional integrations (E2B, Tavily, GitHub, ElevenLabs, Twilio, etc.) degrade gracefully when env vars are missing — they disable features rather than crash.
- `.env.local` at the repo root is the single env file for local dev (gitignored). Copy from `.env.example` and fill in real values as needed.

# Aura

Aura is an AI team member that lives in Slack -- a persistent, autonomous colleague with memory, judgment, and the ability to act.

She reads context, remembers every conversation, initiates work without being asked, and gets smarter over time. She has persistent memory, a self-improvement loop, and the ability to act autonomously: file issues, make phone calls, send emails, query data warehouses, run code, dispatch coding agents, and more -- all without leaving your workspace.

She also maintains her own knowledge base, writes and executes playbooks, and updates her own system prompt when she learns something important.

Built with TypeScript, Hono, Vercel serverless functions, Vercel AI SDK v6, and PostgreSQL.

---

## What she can do

**Slack** — messages, threads, channels, DMs, reactions, canvases, lists, user lookups, file uploads, search across the workspace

**Email** — Gmail send/read/reply/draft, inbox sync, triage and digest, semantic search (per-user OAuth)

**Calendar** — Google Calendar event creation and management (per-user OAuth)

**Data** — BigQuery SQL, Google Sheets, Google Drive search and file reading

**Voice** — Outbound phone calls and SMS via ElevenLabs + Twilio, text-to-speech voice notes

**Sandbox** — Persistent Linux VM (E2B) with pre-baked tools: `psql`, `jq`, `rg`, `gcloud`, `claude`, `pdftotext`, `mongosh`

**Coding agents** — Dispatch, monitor, and follow up on Cursor Cloud Agents; also Claude and Codex agents

**Browser** — Playwright automation via Browserbase: screenshots, scraping, multi-step interactions

**Web** — Web search (Tavily) + URL content extraction

**Knowledge** — Persistent notes (skills, plans, reference docs), resource ingestion (URLs, PDFs, Notion, YouTube), semantic and full-text search

**People** — Structured profiles with contact info, org relationships, activity tracking

**Credentials** — Encrypted token/OAuth storage with per-user access control and audit logging

**Memory** — After every exchange, facts, decisions, and open threads are extracted, embedded, and stored. Semantic search over all past conversations.

**Jobs** — Scheduled and recurring tasks with cron execution, playbooks, and retry logic. Aura creates jobs for herself when she spots recurring work.

---

## Architecture

Slack event → Vercel serverless function → embed query → pgvector similarity search for relevant memories → build system prompt → call LLM (via Vercel AI Gateway) → stream response to Slack → background: extract memories, update profiles.

**Runtime:** Vercel serverless (Node.js). Stateless between messages. One message = one function invocation.

**Memory:** Every exchange triggers a fast-model LLM call that extracts structured memories (facts, decisions, relationships, open threads). Each memory is a 1536-dimensional pgvector embedding. Top ~10 most similar memories are retrieved on each response. DM-sourced memories are private by default.

**Sandbox:** Persistent E2B VM attached to each user. Survives across conversations within a session. Has git, psql, gcloud, the GitHub CLI, `mongosh`, the `mongodb` node driver, and more. `run_command_detached` is a suspend point when webhook callbacks are configured: the active Slack turn ends after dispatch, and `/api/webhook/sandbox-command` resumes the same thread with a synthetic `<detached-command-result>` user turn when the process exits. Build the custom template with `node sandbox/build-tsx.ts`.

**Scratch storage:** When `MONGODB_ATLAS_URI` is set, Aura uses MongoDB Atlas as a schema-less scratch layer for arbitrary per-task collections (cross-session job state, dumps, staging). Postgres stays mission-critical and schema-managed; Mongo is the ad-hoc workspace. See `content/docs/tools/sandbox.mdx`.

**Jobs/heartbeat:** A cron runs every 30 minutes. One-shot jobs fire at their scheduled time. Recurring jobs evaluate against their cron expression and frequency limits. Failed jobs retry 3× with 30-minute backoff.

---

## Setup

### 1. Database

Create a [Neon](https://neon.tech) Postgres database and set `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED`. The schema deploys automatically via Drizzle on first run.

### 2. Slack app

Create a Slack app at [api.slack.com](https://api.slack.com/apps).

**Bot token scopes:**
```
app_mentions:read, channels:history, channels:join, channels:manage, channels:read,
chat:write, files:read, files:write, groups:history, groups:read, im:history,
im:read, im:write, mpim:history, mpim:read, mpim:write, reactions:read,
reactions:write, users:read, users:read.email
```

**User token scopes (for workspace search):**
```
channels:history, channels:read, groups:history, im:history, mpim:history,
reactions:read, search:read, users:read
```

**Event subscriptions:** `app_mention`, `message.im`

Set `SLACK_BOT_TOKEN`, `SLACK_USER_TOKEN`, `SLACK_SIGNING_SECRET`, and `AURA_BOT_USER_ID`.

### 3. LLM

Enable [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) on your project and set `ANTHROPIC_API_KEY`.

Set `CRON_SECRET` to any random string — this protects the `/cron` endpoint.

### 4. Deploy

```bash
vercel deploy --prod
```

For local development: `vercel env pull && vercel dev`

---

## Optional integrations

Each integration degrades gracefully if unconfigured — missing keys disable features, they don't crash.

| Integration | Env vars | What it enables |
|------------|----------|----------------|
| [E2B](https://e2b.dev) | `E2B_API_KEY`, `E2B_TEMPLATE_ID` | Shell execution, code running, git |
| [Tavily](https://tavily.com) | `TAVILY_API_KEY` | Web search + URL extraction |
| [GitHub](https://github.com) | `GITHUB_TOKEN` | Issues, PRs, code review |
| [ElevenLabs](https://elevenlabs.io) | `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | Voice calls, TTS voice notes |
| [Twilio](https://twilio.com) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Outbound calls + SMS |
| [Browserbase](https://browserbase.com) | `BROWSERBASE_API_KEY` | Browser automation, screenshots |
| [Cursor](https://cursor.com) | `CURSOR_API_KEY`, `CURSOR_WEBHOOK_SECRET` | Coding agent dispatch |
| [BigQuery](https://cloud.google.com) | `GOOGLE_SA_KEY_B64` | Data warehouse queries |
| Google OAuth | `GOOGLE_EMAIL_CLIENT_ID`, `GOOGLE_EMAIL_CLIENT_SECRET` | Per-user Gmail, Calendar, Drive, Sheets |
| [Vercel](https://vercel.com) | `VERCEL_TOKEN` | Deployment logs, self-diagnosis |
| [Cohere](https://cohere.com) | `COHERE_API_KEY` | Reranking for better memory retrieval |
| [Browserbase CF](https://browserbase.com) | `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Auth'd domains via Cloudflare Access |

---

## Memory PR checklist

The harness in `apps/api/bench/` makes memory PRs falsifiable. It replays vendored LoCoMo + LongMemEval corpora through Aura's real `extract → retrieve → answer` pipeline, scores per category with both deterministic retrieval recall@15 and LLM-judged QA accuracy, and persists every run to `bench_runs` so deltas are honest.

### When does it run?

* **Automatically on PRs** when a memory-relevant path changes — `apps/api/src/memory/**`, `apps/api/bench/**`, `apps/api/src/personality/system-prompt.ts`, `apps/api/src/pipeline/core-prompt.ts`, `packages/db/src/schema.ts`, or `packages/db/drizzle/**`. Other PRs skip the bench entirely so we don't burn cycles on unrelated changes.
* **Manually via `workflow_dispatch`** in the GitHub UI (Actions → Memory bench → Run workflow), with optional subset (`fast | medium | full`) and dataset (`toy | lme | locomo | both`).
* **Locally**, any time. Useful when iterating on a memory change before pushing.

There is **no nightly cron** — the corpora and the codepath are both stable, so re-running the same bench every night would just spend money on identical numbers. PRs and manual runs are the right cadence.

### Local workflow

```bash
# One-time: cache the real corpora locally (~62 MB, gitignored).
pnpm bench:fetch-corpus

# Cheap smoke test (3 questions, ~$0.05, ~30s)
pnpm bench:memory --dataset=toy

# Standard run — Sonnet for extraction + answerer, Opus as judge.
# ~300 questions across LoCoMo + LongMemEval, ~$3–7.
pnpm bench:memory --dataset=both --subset=medium

# PR-speed iteration loop (~40 Qs, ~$0.50)
pnpm bench:memory --dataset=both --subset=fast

# Full corpus — every question. Costs real money, only run when warranted.
pnpm bench:memory --dataset=both --subset=full

# Pin specific models (overrides Sonnet/Opus defaults from bench/src/models.ts)
pnpm bench:memory --extraction-model=anthropic/claude-haiku-4.5 \
                  --answerer-model=anthropic/claude-sonnet-4.6 \
                  --judge-model=anthropic/claude-opus-4.6
```

`--prod` switches to `.env.production`. `--dry-run` validates corpora load without any DB writes or LLM calls. `--json=path` writes per-question detail.

### What to put in the PR description

The CI bench posts a sticky comment automatically. For the description, paste at least the rows your change targets, plus two it shouldn't affect:

| Dataset | Category | Before | After | Δ |
|---|---|---|---|---|
| LongMemEval | temporal-reasoning | 39% | 46% | **+7pp** |
| LongMemEval | knowledge-update | 31% | 33% | +2pp |
| LongMemEval | abstention | 28% | 27% | -1pp |
| LoCoMo | multi_hop | 41% | 40% | -1pp |
| Retrieval recall@15 (overall) | — | 67% | 71% | +4pp |
| Runtime / cost | — | 8m02s / $4.18 | 8m11s / $4.31 | — |

Regressions > **2pp** on any category require explicit justification. The PR-time gate (`.github/workflows/memory-bench.yml`) surfaces them automatically; once we have a noise floor, flip `STRICT_REGRESSION_GATE: "true"` to turn warnings into hard fails. Apply the `override-bench` label to merge through a justified regression.

### Adding new evidence

* **New corpus** → entry in `apps/api/bench/corpus/manifest.json` (set `vendored: false` + a `fetchUrl`; the file lands in the gitignored `cache/` dir), and a loader in `apps/api/bench/src/fixtures.ts` that returns `BenchCase[]`.
* **New scoring lane** → new `ScoreType` in `apps/api/bench/src/types.ts` + branch in `aggregateScores()`.
* **New judge prompt** → drop next to the existing ones in `apps/api/bench/src/judge.ts` and route via `pickPrompt()`.

---

## Troubleshooting

**Aura doesn't respond to DMs**
- Check that `im:history` and `im:read` scopes are added and `message.im` event subscription is enabled
- Verify `AURA_BOT_USER_ID` matches the bot's actual Slack user ID

**Aura doesn't respond to @mentions**
- Invite Aura to the channel first (`/invite @Aura`)
- Check that `app_mention` event subscription is enabled

**LLM calls fail**
- Make sure Vercel AI Gateway is enabled on your project
- For local dev, `vercel env pull` first

**Tools show "not available"**
- Check that the relevant env vars are set (see optional integrations above)

**Sandbox has wrong tools**
- If `E2B_TEMPLATE_ID` was recently changed, the old sandbox may be cached. It'll use the new template on the next cold start, or when the old sandbox times out (~5 min).
- See issue [#628](https://github.com/AuraHQ-ai/aura/issues/628) for the template mismatch fix.

---

## License

MIT

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

## Memory benchmark

The harness in `apps/api/bench/` makes memory changes falsifiable. It replays vendored LongMemEval (default) / LoCoMo corpora through Aura's real `extract → retrieve → answer` pipeline on a **production-faithful timeline** — per-assistant-reply extraction runs as a producer that advances a global watermark, and each question is scored the moment the watermark passes its timestamp, retrieving **bi-temporally as-of that instant** (so questions never see the future). It scores per category with both deterministic retrieval recall@15 and LLM-judged QA accuracy, and persists every run to `bench_runs` so deltas are honest.

### Current results

<!-- BENCH_SNAPSHOT:START -->
<!-- Generated from apps/api/bench/history.jsonl — do not edit by hand. -->

Current codebase (as of `0ee6037`, scope `locomo+longmemeval/medium`): **QA 30%** · **recall@15 74%** across 330 questions. Full breakdown + history in [apps/api/bench/README.md](apps/api/bench/README.md).

| dataset | category | QA acc | recall@15 | n |
|---|---|---:|---:|---:|
| locomo | adversarial | 7% | 70% | 30 |
| locomo | multi_hop | 27% | 74% | 30 |
| locomo | open_domain | 17% | 77% | 30 |
| locomo | single_hop | 12% | 87% | 30 |
| locomo | temporal | 20% | 59% | 30 |
| longmemeval | knowledge-update | 67% | 80% | 30 |
| longmemeval | multi-session | 43% | 70% | 30 |
| longmemeval | single-session-assistant | 17% | 67% | 30 |
| longmemeval | single-session-preference | 28% | 73% | 30 |
| longmemeval | single-session-user | 68% | 87% | 30 |
| longmemeval | temporal-reasoning | 20% | 72% | 30 |

<!-- BENCH_SNAPSHOT:END -->

The full per-category breakdown and the run-over-run evolution live in [`apps/api/bench/README.md`](apps/api/bench/README.md), generated from [`apps/api/bench/history.jsonl`](apps/api/bench/history.jsonl). The snapshot above reflects the latest logged run on the current codebase.

### When does it run?

The bench runs **on the server, in CI**, so every memory change ships with real, reproducible numbers:

* **On pull requests** that touch memory-relevant paths (`apps/api/src/memory/**`, `apps/api/bench/**`, the embedding/vector libs, the pipeline, or the DB schema). The action runs the medium LongMemEval (`--dataset=lme --replay=exchange`) pass on an isolated Neon branch, then:
  * **posts a sticky PR comment** with per-category deltas vs the target branch (like a deploy preview), flagging any regression > 2pp, and
  * **commits the regenerated `history.jsonl` + READMEs back to the PR branch**, so the real numbers travel with the change and land on `main` at merge. The commit is pushed with the workflow's `GITHUB_TOKEN`, which by design does not retrigger CI.
* Every non-draft PR also runs the tiny **toy** bench as a fast smoke test.
* **Manually via `workflow_dispatch`** (Actions → Memory bench → Run workflow), with optional subset (`fast | medium | full`), dataset (`toy | lme | locomo | both`), and the staged-reuse knobs (`bench_id`/`from`/`to`) for isolated experiments. Manual runs upload the result JSON as an artifact and don't comment or commit.

Running locally is still the fast iteration loop while you're working on a change (see below) — but you no longer have to remember to run medium/full and paste numbers by hand; CI does that on the PR.

### Local workflow

```bash
# One-time: cache the real corpora locally (~18 MB, gitignored).
pnpm bench:fetch-corpus

# Cheap smoke test (3 questions, ~$0.05, ~30s).
pnpm bench:memory --dataset=toy

# Standard run — main-tier extraction + answerer, escalation-tier judge.
# ~330 questions across LoCoMo + LongMemEval, ~1h, ~$10.
pnpm bench:memory --dataset=both --subset=medium --log

# Fast iteration loop (~44 Qs, a few min, ~$2).
pnpm bench:memory --dataset=both --subset=fast --log

# Full corpus — every question (~2,486 Qs, ~2–3h). Costs real money; ask before running.
pnpm bench:memory --dataset=both --subset=full --concurrency=4 --log

# Bring-your-own normalized corpus, skipping fetch-corpus entirely.
pnpm bench:memory --corpus-file=/tmp/my-cases.json --subset=full
```

Models are slotted onto three catalog **tiers** (`fast`, `main`, `escalation`). Defaults: `extraction=main`, `answerer=main`, `judge=escalation`. When the team updates "main" to point at the next-gen Sonnet, the bench picks it up automatically. The resolved gateway id is persisted on every `bench_runs` row so cross-run deltas stay honest.

Override per-slot via either a tier name or an explicit gateway id:

```bash
# Override one slot to Haiku-tier via the catalog
pnpm bench:memory --extraction-model=fast

# Or pin an exact id
pnpm bench:memory --judge-model=anthropic/claude-opus-4.6
```

`--prod` switches to `.env.production`. `--dry-run` validates corpora load without any DB writes or LLM calls. `--json=path` writes per-question detail.

### Iterating: ramp the data up, don't boil the ocean

Don't jump straight to the full corpus. Start tiny, confirm the axis you're working on improves, then widen. There's no point scoring 1,500 LoCoMo questions while `temporal` and `knowledge_update` sit at 0% — fix those on a handful of cases first.

`--limit=N` caps cases **per category** (overriding `--subset`), and `--category=` narrows to the one axis you're fixing:

```bash
# Tight loop on the failing axis — 3 cases, seconds, cents.
pnpm bench:memory --dataset=lme --category=temporal-reasoning --limit=3

# Looks better? Widen to 10 and log the result for the record.
pnpm bench:memory --dataset=lme --category=temporal-reasoning --limit=10 --log --note="extractor durability fix"

# Axis healthy across categories? Now it's worth the full run.
pnpm bench:memory --dataset=both --subset=full --concurrency=4 --log
```

### Results log (commit fingerprints)

`--log` appends a structured entry to [`apps/api/bench/history.jsonl`](apps/api/bench/history.jsonl) — runId, commit SHA, corpus hash, config, resolved models, cost, and per-category scores — then regenerates [`apps/api/bench/README.md`](apps/api/bench/README.md) and the snapshot block above. Commit all three alongside the change so every result is permanently tied to the code that produced it; `git log` on `history.jsonl` shows whether a change actually moved the needle. A `-dirty` suffix on the commit flags runs that included uncommitted changes. Add `--note="…"` to annotate what you were trying. Regenerate the markdown from history at any time with `pnpm bench:report` (no DB or LLM needed).

### What goes in the PR

You don't paste numbers by hand. The **Memory bench** action posts a sticky comment on the PR with the per-category before/after/Δ table (QA + recall@15) computed against the target branch, and commits the regenerated `history.jsonl` + READMEs to your branch. The comment looks like:

| Dataset | Category | QA before | QA after | QA Δ | recall before | recall after | recall Δ | n |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| longmemeval | temporal-reasoning | 39% | 46% | +7pp | 77% | 79% | +2pp | 30 |
| … | | | | | | | | |

Any category that regresses by more than **2pp** is flagged in the comment and **requires explicit justification in the PR description**. If there's no comparable baseline on the target branch yet (corpus or case-set changed), the comment shows absolute scores instead of deltas. Because the sampler is deterministic, a PR run and the target branch's run at the same subset/corpus diff like-for-like.

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

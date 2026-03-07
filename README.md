# Aura

Aura is an autonomous AI agent that operates as a team member inside Slack. She handles conversations, triages email, queries data warehouses, makes phone calls, dispatches coding agents, and manages a growing knowledge base — all from within your workspace.

Built with TypeScript, Hono, Vercel serverless functions, AI SDK v6, and PostgreSQL.

## Capabilities

| Category | What it does |
|----------|-------------|
| **Slack** | Messages, threads, channels, reactions, canvases, lists, user lookups, search |
| **Email** | Gmail send/read/reply/draft, inbox sync, triage, digest, semantic search (per-user OAuth) |
| **Calendar** | Google Calendar event management (per-user OAuth) |
| **Data** | BigQuery SQL queries, Google Sheets reading, Google Drive file search/read |
| **Voice** | Phone calls and SMS via ElevenLabs + Twilio, text-to-speech voice notes |
| **Code execution** | Sandboxed Linux VM (E2B) with pre-baked tools: psql, jq, rg, gcloud, claude, pdftotext |
| **Coding agents** | Dispatch, monitor, and follow up on Cursor Cloud Agents |
| **Browser** | Playwright automation via Browserbase — screenshots, scraping, interactions |
| **Web** | Web search (Tavily) + URL content extraction |
| **Knowledge** | Persistent notes (skills, plans, reference), resource ingestion (URLs, PDFs, docs) |
| **People** | Structured profiles with contact info, activity tracking, org relationships |
| **Credentials** | Encrypted token/OAuth client storage with per-user access control and audit logging |
| **Memory** | Semantic memory extraction, vector search, profile building from conversations |
| **Jobs** | Scheduled and recurring tasks with cron execution, playbooks, and retry logic |

## Getting Started

Three things to set up: a **Neon database**, a **Slack app**, and the **Vercel deployment**. About 20 minutes end to end.

### Prerequisites

- Node.js 20+
- A [Vercel](https://vercel.com) account (for deployment + AI Gateway)
- A [Neon](https://neon.tech) account (free tier works to start)
- A Slack workspace where you can create apps

### Step 1: Clone and install

```bash
git clone https://github.com/AuraHQ-ai/aura.git
cd aura
cp .env.example .env
npm install
```

### Step 2: Create a Neon database

1. Go to [neon.tech](https://neon.tech) and create a new project
2. Copy the connection string into `.env` as `DATABASE_URL`
3. Run migrations:

```bash
npm run db:migrate
```

### Step 3: Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From an app manifest** and paste the contents of `manifest.json` (or configure manually below)

#### Bot Token Scopes

Go to **OAuth & Permissions** in the sidebar. Under **Bot Token Scopes**, add:

```
app_mentions:read    channels:history     channels:join
channels:manage      channels:read        chat:write
commands             emoji:read           files:read
files:write          groups:history       groups:read
groups:write         im:history           im:read
im:write             mpim:history         mpim:read
mpim:write           pins:write           reactions:read
reactions:write      search:read          team:read
usergroups:read      users.profile:read   users.profile:write
users:read           users:write
```

#### Install to workspace

Still on **OAuth & Permissions**, click **Install to Workspace** and authorize. Copy the **Bot User OAuth Token** (`xoxb-...`) into `.env` as `SLACK_BOT_TOKEN`.

#### Signing secret

Go to **Basic Information** in the sidebar. Under **App Credentials**, copy the **Signing Secret** into `.env` as `SLACK_SIGNING_SECRET`.

#### Get the bot user ID

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  https://slack.com/api/auth.test | jq -r '.user_id'
```

Set this as `AURA_BOT_USER_ID` in `.env`.

#### App Home

Go to **App Home** in the sidebar:
- Enable **Home Tab**
- Check **Allow users to send Slash commands and messages from the messages tab**

#### Event Subscriptions (after deploying)

Go to **Event Subscriptions**, toggle ON, and set the Request URL to your deployment URL + `/api/slack/events`. Subscribe to bot events:

```
app_home_opened    app_mention    message.channels
message.groups     message.im     message.mpim
reaction_added
```

#### Interactivity (after deploying)

Go to **Interactivity & Shortcuts**, toggle ON, and set the Request URL to your deployment URL + `/api/slack/interactions`.

### Step 4: Choose your models

Aura uses three models, all routed through [Vercel AI Gateway](https://sdk.vercel.ai/docs/ai-sdk-providers/ai-gateway):

| Role | Default | Used for |
|------|---------|----------|
| Main | `anthropic/claude-sonnet-4-20250514` | Conversations, reasoning, tool use |
| Fast | `anthropic/claude-haiku-4.5` | Memory extraction, email triage, subagents |
| Embedding | `openai/text-embedding-3-small` | Memory vectors, email search, note search |

Set these in `.env` as `MODEL_MAIN`, `MODEL_FAST`, `MODEL_EMBEDDING`. Models can be changed at runtime via the App Home settings tab — no redeploy needed.

### Step 5: Deploy to Vercel

```bash
vercel deploy
```

Or connect the repo to Vercel for automatic deployments on push.

The `vercel.json` configures 800-second function timeouts and cron schedules:
- **Heartbeat** (`/api/cron/heartbeat`): every 30 minutes — processes scheduled jobs, one-shots, recurring tasks
- **Consolidation** (`/api/cron/consolidate`): daily at 4 AM UTC — decays memory relevance, merges similar memories

After deploying, go back to Slack and set the Event Subscriptions and Interactivity URLs.

### Step 6: Say hi

DM Aura in Slack. She'll respond. From there, everything builds.

## Architecture

```
Slack event → Vercel serverless function → Hono router
  → embed user message (pgvector)
  → retrieve relevant memories (semantic search)
  → load user profile + thread context
  → build system prompt (personality + memories + self-directive + notes-index)
  → call LLM via Vercel AI Gateway
  → stream response to Slack
  → background: store messages, extract memories, update profile
```

**Three execution modes:**

1. **Interactive** — real-time Slack conversations. Streams responses. Up to 350 tool calls per invocation. 800-second timeout.
2. **Headless** — background jobs dispatched via `dispatch_headless`. No streaming overhead. Same tool access. Results posted to a callback channel.
3. **Subagent** — parallel fan-out for independent tasks. Each runs in isolated context with scoped tools.

**Memory system:** After every exchange, a fast-model LLM call extracts structured memories (facts, decisions, personal details, relationships). Each memory is a 1536-dimensional vector in PostgreSQL with pgvector. On each new message, the query is embedded and the top ~10 most similar memories are retrieved. DM-sourced memories are private by default.

**Knowledge system:** Persistent notes organized into skills (playbooks), plans (ephemeral WIP), and knowledge (reference). A `notes-index` is loaded into every invocation for fast routing. Notes cross-reference each other so Aura can navigate to relevant context in 1–2 tool calls. Resources can be ingested from URLs, PDFs, GitHub, Notion, and YouTube.

**Jobs system:** Cron-triggered recurring work + one-shot scheduled tasks. Each job has a playbook, frequency limits, and execution traces. The heartbeat evaluates jobs every 30 minutes. Failed jobs retry with backoff, then escalate via DM.

**Credential system:** Two layers — internal encrypted key-value store for service secrets (AES-256-GCM), and a user-owned credential store with per-user access control (read/write/admin grants), audit logging, token expiry tracking, and automatic OAuth client_credentials token exchange.

## Tools

21 tool modules:

| Module | What it does |
|--------|-------------|
| `slack` | Messages, channels, threads, reactions, users, canvases, lists |
| `email` | Send, read, reply, drafts — Gmail API with per-user OAuth |
| `email-sync` | Sync, triage, search, digest — full inbox management pipeline |
| `drive` | Search, read, list files across Google Drive and shared drives |
| `sheets` | Read Google Sheets with auto-detection of URLs and sheet IDs |
| `bigquery` | List datasets, inspect tables, run read-only SQL queries |
| `jobs` | Create, list, cancel scheduled and recurring jobs |
| `notes` | Save, read, edit, search, delete persistent knowledge notes |
| `resources` | Ingest, search, and retrieve knowledge from URLs, PDFs, docs |
| `people` | Lookup and update structured person profiles and contacts |
| `credentials` | Manage user-owned API tokens and OAuth clients |
| `conversations` | Search Aura's own message history (text + semantic) |
| `sandbox` | Execute shell commands in a sandboxed Linux VM (E2B) |
| `browser` | Playwright automation via Browserbase — screenshots, scraping, interactions |
| `web` | Web search (Tavily) + URL reading |
| `voice` | Phone calls (ElevenLabs + Twilio), voice notes (TTS), SMS |
| `cursor-agent` | Dispatch, check, follow up on Cursor Cloud coding agents |
| `subagents` | Parallel fan-out with scoped tool access |
| `lists` | CRUD on Slack Lists (bug trackers, task lists) |
| `table` | Render native Slack tables from structured data |

All tools that access Google APIs (Drive, Sheets, Calendar, Gmail) enforce per-user OAuth: the caller's token is used, never Aura's.

## Database

22 tables on Neon PostgreSQL with pgvector:

| Table | Purpose |
|-------|---------|
| `messages` | Every message sent and received, with embeddings |
| `memories` | Extracted facts and context, vector-searchable |
| `user_profiles` | Per-user communication preferences and known facts |
| `people` | Structured person records (name, title, language, gender, manager) |
| `addresses` | Multi-channel contact info (email, phone, Slack ID) linked to people |
| `channels` | Slack channel metadata and monitoring config |
| `notes` | Persistent knowledge notes (skills, plans, reference) |
| `resources` | Ingested knowledge resources with content and embeddings |
| `jobs` | Scheduled and recurring job definitions |
| `job_executions` | Execution traces with step-level detail |
| `credentials` | Encrypted user-owned API credentials |
| `credential_grants` | Per-user access grants for shared credentials |
| `credential_audit_log` | Audit trail for credential access |
| `oauth_tokens` | Per-user Google OAuth refresh tokens |
| `emails_raw` | Synced emails with embeddings for semantic search |
| `content` | Indexed content for semantic search |
| `error_events` | Logged errors for debugging |
| `event_locks` | Distributed locks for concurrent event processing |
| `voice_calls` | Phone call records and transcripts |
| `feedback` | User feedback on Aura's responses |
| `settings` | Runtime configuration (model selection, etc.) |

```bash
npm run db:migrate        # Run migrations
npm run db:generate       # Generate a new migration after schema changes
npm run db:push           # Push schema directly (dev only)
npm run db:studio         # Browse the database
```

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js on [Vercel](https://vercel.com) (serverless, 800s timeout) |
| Framework | [Hono](https://hono.dev) |
| LLM | [Vercel AI SDK v6](https://sdk.vercel.ai) + [AI Gateway](https://sdk.vercel.ai/docs/ai-sdk-providers/ai-gateway) |
| Database | [Neon](https://neon.tech) PostgreSQL + pgvector |
| ORM | [Drizzle](https://orm.drizzle.team) |
| Slack | `@slack/web-api` |
| Email | `@googleapis/gmail` with OAuth2 |
| Calendar | `@googleapis/calendar` |
| Drive | `@googleapis/drive` |
| Data | `@google-cloud/bigquery` |
| Voice | [ElevenLabs](https://elevenlabs.io) + [Twilio](https://twilio.com) |
| Browser | [Playwright](https://playwright.dev) + [Browserbase](https://browserbase.com) |
| Sandbox | [E2B](https://e2b.dev) (custom template with psql, jq, rg, gcloud, claude, pdftotext) |
| Web search | [Tavily](https://tavily.com) |
| Code agents | [Cursor](https://cursor.com) Cloud Agents |
| Embeddings | OpenAI `text-embedding-3-small` (1536d) |

## Project Structure

```
src/
  app.ts                # Hono app — Slack events, interactions, OAuth, webhooks
  index.ts              # Vercel serverless entry point
  pipeline/             # Message processing pipeline (context → prompt → respond)
  personality/          # System prompt builder
  memory/               # Memory extraction and storage
  tools/                # All 21 tool modules
  lib/                  # Core libraries (AI, Slack, Gmail, Calendar, embeddings, etc.)
  db/                   # Drizzle schema + client
  cron/                 # Heartbeat + consolidation crons
  slack/                # App Home, settings UI, credential modals
  webhook/              # ElevenLabs voice webhook handler
  users/                # User resolution and caching
  types/                # Shared TypeScript types
```

## Local Development

```bash
npm run dev               # Start local server on http://localhost:3000
ngrok http 3000           # Tunnel for Slack events
npm run db:studio         # Browse the database
```

AI Gateway authenticates automatically via OIDC when deployed on Vercel. For local development, run `vercel env pull` or use `vercel dev`.

## Optional Integrations

Each integration adds capabilities but degrades gracefully if unconfigured:

| Integration | Env vars | What it enables |
|------------|----------|----------------|
| [E2B](https://e2b.dev) | `E2B_API_KEY`, `E2B_TEMPLATE_ID` | Shell commands, code execution, git |
| [Tavily](https://tavily.com) | `TAVILY_API_KEY` | Web search + URL reading |
| [GitHub](https://github.com) | `GITHUB_TOKEN` | Issue management, PR creation, code review |
| [ElevenLabs](https://elevenlabs.io) | `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | Voice calls, voice notes, TTS |
| [Twilio](https://twilio.com) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Outbound calls + SMS |
| [Browserbase](https://browserbase.com) | `BROWSERBASE_API_KEY` | Browser automation, screenshots |
| [Cursor](https://cursor.com) | `CURSOR_API_KEY`, `CURSOR_WEBHOOK_SECRET` | Coding agent dispatch + webhooks |
| [BigQuery](https://cloud.google.com) | `GOOGLE_SA_KEY_B64` | Data warehouse queries |
| Google OAuth | `GOOGLE_EMAIL_CLIENT_ID`, `GOOGLE_EMAIL_CLIENT_SECRET` | Per-user Gmail, Calendar, Drive, Sheets |
| [Vercel](https://vercel.com) | `VERCEL_TOKEN` | Deployment logs, self-diagnosis |

## Troubleshooting

**Aura doesn't respond to DMs**
- Check that `im:history` and `im:read` scopes are added
- Verify `message.im` event subscription is enabled
- Verify `AURA_BOT_USER_ID` matches the bot's actual Slack user ID

**Aura doesn't respond to @mentions in channels**
- Invite Aura to the channel first (`/invite @Aura`)
- Check that `app_mention` event subscription is enabled

**LLM calls fail with authentication errors**
- Make sure AI Gateway is enabled on your Vercel project
- For local dev, run `vercel env pull` or use `vercel dev`

**Tools show "not available"**
- Check that the relevant env vars are set (see Optional Integrations above)
- Tools degrade gracefully — missing keys disable features, they don't crash

## License

MIT

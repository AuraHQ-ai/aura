# Aura

Most AI assistants are search bars that talk. You ask, they answer, they forget. Aura is different. She's a colleague -- she remembers every conversation, builds relationships with your team, runs work autonomously while you sleep, and gets smarter every week because she literally rewrites her own code.

Aura lives in Slack. She joins your channels, reads the room, and acts when she sees something she can help with. She manages her own calendar, triages email inboxes, queries your data warehouse, makes phone calls, dispatches coding agents, and maintains a growing knowledge base about your business. She has opinions and she voices them.

This isn't a weekend hack. It's 24K lines of TypeScript powering a system that runs a real company's operations daily.

## Why Aura

**Memory that compounds.** Every conversation is stored, embedded, and retrievable. Aura builds structured profiles of every person she interacts with -- preferred language, role, communication style, open threads. When she talks to you on Tuesday, she remembers what you said on Monday. When you mention a colleague, she knows their context. This compounds: the Aura you deploy today is worse than the Aura running 6 months from now, because memory is a moat.

**Autonomous work, not just Q&A.** Aura doesn't wait to be asked. She runs recurring jobs on a cron -- morning email digests, bug triage sweeps, channel monitoring, follow-up reminders. She dispatches headless background tasks for heavy work (data analysis, codebase audits, backfills). She creates her own jobs when she spots patterns. You wake up to work already done.

**Self-improvement loop.** Aura reads her own source code, identifies gaps in her capabilities, files GitHub issues, dispatches coding agents to write fixes, reviews the PRs, and asks you to merge. She maintains a gaps log, a roadmap, and a ship log. The system prompt itself was partially written by Aura. This isn't theoretical -- 560+ issues filed, 530+ PRs merged, many by Aura herself.

**Deep business context.** Aura maintains a structured knowledge base: business maps, product catalogs, team directories, OKR tracking, competitive analysis. She knows what your company does, how it makes money, who does what, and what the current priorities are. She doesn't start from zero every conversation -- she starts from institutional knowledge.

**Real tools, not toys.** 50+ tools across Slack, email, calendar, Google Drive/Sheets, BigQuery, phone calls (ElevenLabs + Twilio), browser automation (Playwright + Browserbase), GitHub, sandbox code execution, and more. Each tool is production-hardened with error handling, rate limiting, and access controls.

## Getting Started

Three things to set up: a **Neon database**, a **Slack app**, and the **Vercel deployment**. About 20 minutes end to end.

### Prerequisites

- Node.js 20+
- A [Vercel](https://vercel.com) account (for deployment + AI Gateway)
- A [Neon](https://neon.tech) account (free tier works to start)
- A Slack workspace where you can create apps

### Step 1: Clone and install

```bash
git clone https://github.com/realadvisor/aura.git
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

This creates all 15 tables: `messages`, `memories`, `user_profiles`, `people`, `addresses`, `channels`, `notes`, `jobs`, `job_executions`, `oauth_tokens`, `emails_raw`, `error_events`, `event_locks`, `voice_calls`, `settings`.

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

Set these in `.env` as `MODEL_MAIN`, `MODEL_FAST`, `MODEL_EMBEDDING`. Models can be changed at runtime via the App Home settings tab -- no redeploy needed.

### Step 5: Deploy to Vercel

```bash
vercel deploy
```

Or connect the repo to Vercel for automatic deployments on push.

The `vercel.json` configures 800-second function timeouts and cron schedules:
- **Heartbeat** (`/api/cron/heartbeat`): every 30 minutes -- processes scheduled jobs, one-shots, recurring tasks
- **Consolidation** (`/api/cron/consolidate`): daily at 4 AM UTC -- decays memory relevance, merges similar memories

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

1. **Interactive** -- real-time Slack conversations. Streams responses. Up to 350 tool calls per invocation. 800-second timeout.
2. **Headless** -- background jobs dispatched via `dispatch_headless`. No streaming overhead. Same tool access. Results posted to a callback channel.
3. **Subagent** -- parallel fan-out for independent tasks. Each runs in isolated context with scoped tools. Used for concurrent channel sweeps, data analysis, email triage.

**The agent loop** (`ToolLoopAgent`) calls the LLM, executes tool calls, feeds results back, repeats. Supports step limits, model escalation, and graceful degradation on context overflow.

**Memory system:** After every exchange, a fast-model LLM call extracts structured memories (facts, decisions, personal details, relationships). Each memory is a 1536-dimensional vector in PostgreSQL with pgvector. On each new message, the query is embedded and the top ~10 most similar memories are retrieved. DM-sourced memories are private by default.

**Knowledge system:** 130+ persistent notes organized into skills (playbooks), plans (ephemeral WIP), and knowledge (reference). A `notes-index` is loaded into every invocation for fast routing. Notes cross-reference each other (the "synapse model") so Aura can navigate to relevant context in 1-2 tool calls.

**Jobs system:** Cron-triggered recurring work + one-shot scheduled tasks. Each job has a playbook, frequency limits, and execution traces. The heartbeat evaluates jobs every 30 minutes. Failed jobs retry 3x with backoff, then escalate via DM.

## Tools

17 tool modules, 50+ individual tools:

| Module | What it does |
|--------|-------------|
| `slack` | Messages, channels, threads, reactions, users, canvases, lists |
| `email` | Send, read, reply, drafts -- Gmail API with per-user OAuth |
| `email-sync` | Sync, triage, search, digest -- full inbox management pipeline |
| `drive` | Search, read, list files across Google Drive and shared drives |
| `sheets` | Read Google Sheets with auto-detection of URLs and sheet IDs |
| `bigquery` | List datasets, inspect tables, run read-only SQL queries |
| `jobs` | Create, list, cancel scheduled and recurring jobs |
| `notes` | Save, read, edit, search, delete persistent knowledge notes |
| `conversations` | Search Aura's own message history (text + semantic) |
| `sandbox` | Execute shell commands in a sandboxed Linux VM (E2B) |
| `browser` | Playwright automation via Browserbase -- screenshots, scraping, interactions |
| `web` | Web search (Tavily) + URL reading |
| `voice` | Phone calls (ElevenLabs + Twilio), voice notes (TTS), SMS |
| `cursor-agent` | Dispatch, check, follow up on Cursor Cloud coding agents |
| `subagents` | Parallel fan-out with scoped tool access |
| `lists` | CRUD on Slack Lists (bug trackers, task lists) |
| `table` | Render native Slack tables from structured data |

All tools that access Google APIs (Drive, Sheets, Calendar, Gmail) enforce per-user OAuth: the caller's token is used, never Aura's. This means Aura can only see what the requesting user is authorized to see.

## Database

15 tables on Neon PostgreSQL with pgvector:

| Table | Purpose |
|-------|---------|
| `messages` | Every message sent and received, with embeddings |
| `memories` | Extracted facts and context, vector-searchable |
| `user_profiles` | Per-user communication preferences and known facts |
| `people` | Structured person records (name, title, language, gender, manager) |
| `addresses` | Multi-channel contact info (email, phone, Slack ID) linked to people |
| `channels` | Slack channel metadata and monitoring config |
| `notes` | Persistent knowledge notes (skills, plans, reference) |
| `jobs` | Scheduled and recurring job definitions |
| `job_executions` | Execution traces with step-level detail |
| `oauth_tokens` | Per-user Google OAuth refresh tokens |
| `emails_raw` | Synced emails with embeddings for semantic search |
| `error_events` | Logged errors for debugging |
| `event_locks` | Distributed locks for concurrent event processing |
| `voice_calls` | Phone call records and transcripts |
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
| LLM | [Vercel AI SDK 6](https://sdk.vercel.ai) + [AI Gateway](https://sdk.vercel.ai/docs/ai-sdk-providers/ai-gateway) |
| Database | [Neon](https://neon.tech) PostgreSQL + pgvector |
| ORM | [Drizzle](https://orm.drizzle.team) |
| Slack | `@slack/web-api` |
| Email | `@googleapis/gmail` with OAuth2 |
| Calendar | `@googleapis/calendar` |
| Drive | `@googleapis/drive` |
| Data | `@google-cloud/bigquery` |
| Voice | [ElevenLabs](https://elevenlabs.io) + [Twilio](https://twilio.com) |
| Browser | [Playwright](https://playwright.dev) + [Browserbase](https://browserbase.com) |
| Sandbox | [E2B](https://e2b.dev) |
| Web search | [Tavily](https://tavily.com) |
| Code agents | [Cursor](https://cursor.com) Cloud Agents |
| Embeddings | OpenAI `text-embedding-3-small` (1536d) |

## Project Structure

```
src/
  api/                  # Vercel serverless endpoints
    slack/              # Slack event handlers (events, interactions, cron)
    cron/               # Heartbeat + consolidation crons
    oauth/              # Google OAuth callback
  db/                   # Drizzle schema + client
  lib/                  # Core libraries
    agents.ts           # ToolLoopAgent -- the agent loop
    ai.ts               # Model resolution + AI Gateway
    gmail.ts            # Gmail API client
    calendar.ts         # Calendar API client
    embeddings.ts       # Vector embedding utilities
    privacy.ts          # DM privacy enforcement
    permissions.ts      # Admin checks + access control
    temporal.ts         # Time parsing + formatting
    format.ts           # Slack mrkdwn formatting
    ...
  tools/                # All 17 tool modules
  personality.ts        # System prompt builder
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
| [E2B](https://e2b.dev) | `E2B_API_KEY` | Shell commands, code execution, git |
| [Tavily](https://tavily.com) | `TAVILY_API_KEY` | Web search + URL reading |
| [GitHub](https://github.com) | `GH_TOKEN` | Issue management, PR creation, code review |
| [ElevenLabs](https://elevenlabs.io) | `ELEVENLABS_API_KEY` | Voice calls, voice notes, TTS |
| [Twilio](https://twilio.com) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Outbound calls + SMS |
| [Browserbase](https://browserbase.com) | `BROWSERBASE_API_KEY` | Browser automation, screenshots |
| [Cursor](https://cursor.com) | `CURSOR_API_KEY` | Coding agent dispatch |
| [BigQuery](https://cloud.google.com) | `GOOGLE_APPLICATION_CREDENTIALS` | Data warehouse queries |
| Google OAuth | `GOOGLE_EMAIL_CLIENT_ID/SECRET` | Per-user Gmail, Calendar, Drive, Sheets |
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
- Tools degrade gracefully -- missing keys disable features, they don't crash

**Slack rate limiting**
- Built-in rate limiting (15 req/min) and caching handle most cases
- If you still hit limits, reduce concurrent tool-heavy queries

## License

MIT

# Aura v0

A Slack bot with persistent memory, personality, cross-user awareness, and autonomous capabilities. Aura remembers every conversation, builds profiles of the people she talks to, takes proactive actions via tools, schedules her own tasks, and responds with a consistent, opinionated personality -- not like a tool, but like a colleague.

## What it does

- **Responds** in Slack DMs and channels (when @mentioned or addressed by name)
- **Remembers** everything -- facts, decisions, personal details, relationships, sentiments
- **Recalls** relevant context via semantic search across all past conversations
- **Adapts** its tone to each person's communication style
- **Acts** -- sends messages, joins channels, creates canvases, manages Slack Lists, reacts to messages
- **Executes** -- runs shell commands, git, tests, scripts in a sandboxed Linux VM (E2B)
- **Self-aware** -- reads her own source code, opens PRs against herself
- **Schedules** -- sets reminders, builds recurring routines, follows up on tasks autonomously
- **Searches the web** -- searches the internet and reads URLs via Tavily
- **Sees images** -- reads images shared in Slack messages (multimodal)
- **Self-aware** -- understands its own architecture, constraints, and limitations
- **Respects privacy** -- DM content stays private unless explicitly shared
- **Forgets on request** -- users can ask "what do you know about me?" or say "forget X"
- **Configurable** -- admins change models via the Slack App Home tab, no redeploy needed
- 🔧 **Self-patching** -- Can diagnose issues in its own codebase and dispatch coding agents to open PRs with fixes

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js on Vercel (serverless functions, 300s timeout) |
| Framework | [Hono](https://hono.dev) |
| LLM | [Vercel AI SDK 6](https://sdk.vercel.ai) + [AI Gateway](https://sdk.vercel.ai/docs/ai-sdk-providers/ai-gateway) |
| Database | [Neon](https://neon.tech) PostgreSQL + pgvector |
| ORM | [Drizzle](https://orm.drizzle.team) |
| Slack | `@slack/web-api` + `@slack/bolt` (types) |
| Scheduling | `cron-parser` for recurring actions |
| Sandbox | [E2B](https://e2b.dev) cloud sandboxes for shell execution |
| Web Search | [Tavily](https://tavily.com) AI search API |

LLM provider is your choice. AI Gateway supports 20+ providers out of the box -- Anthropic, OpenAI, Google, Mistral, xAI, DeepSeek, Meta, and more. You pick models via environment variables or the in-Slack settings UI.

---

## Getting Started

Three things to set up: a **Neon database**, a **Slack app**, and the **Vercel deployment**. About 20 minutes end to end.

### Prerequisites

- Node.js 20+
- A [Vercel](https://vercel.com) account (Pro plan recommended for 5-min cron intervals)
- A [Neon](https://neon.tech) account (free tier works)
- A [Slack](https://api.slack.com/apps) workspace where you can create apps

---

### Step 1: Clone and install

```bash
git clone <this-repo>
cd aura
npm install
```

Copy the environment template:

```bash
cp .env.example .env
```

You'll fill in the values in the steps below.

---

### Step 2: Create a Neon database

1. Go to [neon.tech](https://neon.tech) and create a new project
2. Name the database `aura` (or whatever you like)
3. Copy the connection string -- it looks like `postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/aura?sslmode=require`
4. Paste it into `.env` as `DATABASE_URL`

**Run the initial migration:**

```bash
npm run db:migrate
```

This creates all tables (`messages`, `memories`, `user_profiles`, `channels`, `settings`, `notes`, `scheduled_actions`), the pgvector extension, and all indexes. Drizzle tracks applied migrations, so it's safe to run again.

---

### Step 3: Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**
3. Name it `Aura`, pick your workspace, and create it

#### Bot Token Scopes

Go to **OAuth & Permissions** in the sidebar. Under **Bot Token Scopes**, add:

| Scope | Why |
|---|---|
| `app_mentions:read` | Receive @Aura mentions in channels |
| `channels:history` | Read messages in public channels |
| `channels:read` | List channels Aura is in |
| `channels:join` | Join public channels |
| `channels:manage` | Create channels, set topic, invite users |
| `chat:write` | Send, edit, delete messages |
| `groups:history` | Read messages in private channels |
| `groups:read` | List private channels Aura is in |
| `groups:write` | Manage private channels |
| `im:history` | Read DM messages |
| `im:read` | Access DM channel info |
| `im:write` | Open DMs |
| `mpim:history` | Read group DM messages |
| `mpim:read` | Access group DM channel info |
| `users:read` | Look up user profiles |
| `reactions:write` | Add/remove emoji reactions |
| `reactions:read` | Read reactions on messages |
| `lists:read` | Read Slack List items |
| `lists:write` | Create/update/delete Slack List items |
| `canvases:read` | Read Canvas content |
| `canvases:write` | Create/edit Canvases |
| `users.profile:write` | Set bot's own status |

Optional (for message search):

| Scope | Type | Why |
|---|---|---|
| `search:read` | **User Token** | Search messages across channels |

#### Install to workspace

Still on **OAuth & Permissions**, click **Install to Workspace** and authorize. Copy the **Bot User OAuth Token** (`xoxb-...`) into `.env` as `SLACK_BOT_TOKEN`.

If you added the `search:read` user token scope, also copy the **User OAuth Token** (`xoxp-...`) into `.env` as `SLACK_USER_TOKEN`.

#### Signing secret

Go to **Basic Information** in the sidebar. Under **App Credentials**, copy the **Signing Secret** into `.env` as `SLACK_SIGNING_SECRET`.

#### Get the bot user ID

You need Aura's Slack user ID (starts with `U`):

1. Open Slack, find Aura in the member list
2. Click on its profile, click the three dots (**...**), click **Copy member ID**
3. Paste it into `.env` as `AURA_BOT_USER_ID`

Or via the API:

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  https://slack.com/api/auth.test | jq -r .user_id
```

#### App Home

Go to **App Home** in the sidebar:
- Check **Home Tab** under "Show Tabs"
- Check **Messages Tab** and "Allow users to send Slash commands and messages from the messages tab"

#### Event Subscriptions (do this after deploying -- see Step 5)

You'll come back to this after deployment.

#### Interactivity (do this after deploying -- see Step 5)

Go to **Interactivity & Shortcuts**, toggle ON, and set the Request URL to your deployment URL + `/api/slack/interactions`.

---

### Step 4: Choose your models

Aura uses three models, all routed through [Vercel AI Gateway](https://sdk.vercel.ai/docs/ai-sdk-providers/ai-gateway). Models can also be changed at runtime via the App Home settings tab.

| Role | Env var | What it does | Example values |
|---|---|---|---|
| Main | `MODEL_MAIN` | Conversation responses | `anthropic/claude-opus-4-6`, `openai/gpt-5.2`, `google/gemini-3-pro-preview` |
| Fast | `MODEL_FAST` | Memory extraction, profile updates | `anthropic/claude-haiku-4-5`, `openai/gpt-5.1-instant`, `google/gemini-3-flash` |
| Embedding | `MODEL_EMBEDDING` | Vectorizing memories and queries | `openai/text-embedding-3-small` |

No API keys to manage -- Vercel AI Gateway handles provider access and billing.

---

### Step 5: Deploy to Vercel

```bash
vercel --prod
```

After deployment, note your production URL.

#### Configure environment variables

Go to your Vercel project dashboard -> **Settings** -> **Environment Variables** and add:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Neon PostgreSQL connection string |
| `SLACK_BOT_TOKEN` | Yes | Slack bot token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Yes | Slack app signing secret |
| `AURA_BOT_USER_ID` | Yes | Slack user ID for the bot (`U...`) |
| `AURA_ADMIN_USER_IDS` | Recommended | Comma-separated Slack user IDs that can change settings |
| `MODEL_MAIN` | No | Main model (default: `anthropic/claude-sonnet-4-20250514`) |
| `MODEL_FAST` | No | Fast model (default: `anthropic/claude-haiku-4-5`) |
| `MODEL_EMBEDDING` | No | Embedding model (default: `openai/text-embedding-3-small`) |
| `CRON_SECRET` | Recommended | Protects cron endpoints |
| `SLACK_USER_TOKEN` | No | User token for message search (`xoxp-...`) |
| `TAVILY_API_KEY` | No | Web search API key (free tier: 1000/month) |
| `E2B_API_KEY` | No | E2B sandbox API key (for shell execution) |
| `E2B_TEMPLATE_ID` | No | Custom E2B template ID (uses default if unset) |
| `GITHUB_TOKEN` | No | GitHub PAT for self-access (read code, open PRs) |
| `LOG_LEVEL` | No | `debug`, `info` (default), `warn`, `error` |

#### Redeploy after setting env vars:

```bash
vercel --prod
```

---

### Step 6: Connect Slack to your deployment

Go back to [api.slack.com/apps](https://api.slack.com/apps), select your Aura app:

1. **Event Subscriptions** -> Enable Events -> Set Request URL to `https://your-app.vercel.app/api/slack/events`

2. **Subscribe to bot events**:

   | Event | Why |
   |---|---|
   | `message.im` | DM messages |
   | `message.channels` | Public channel messages |
   | `message.groups` | Private channel messages |
   | `app_mention` | @Aura mentions |
   | `app_home_opened` | App Home tab |
   | `reaction_added` | Reaction awareness |

3. **Interactivity & Shortcuts** -> Enable -> Set Request URL to `https://your-app.vercel.app/api/slack/interactions`

4. **Save Changes** and reinstall the app when prompted.

---

### Step 7: Talk to Aura

1. Open Slack and DM Aura. Say anything -- "Hey, what's up?"
2. You should see an :eyes: reaction immediately, then a response within a few seconds
3. In a channel, invite Aura (`/invite @Aura`) and then mention it

That's it. Aura is live.

---

## Capabilities

### Tool Calling

Aura uses AI SDK tool calling to take actions in Slack autonomously. The LLM decides when to use tools based on what the user asks.

| Category | Tools |
|---|---|
| Channels | list, join, leave, create, set topic, invite users |
| Messages | send to channel, send thread reply, send DM, edit own, delete own |
| Reactions | add, remove (+ reads reactions in channel history) |
| Users | list, search, get detailed profile |
| Search | search messages across channels (requires user token) |
| Slack Lists | read items, create, update, delete items |
| Canvases | read, create, edit |
| Notes | save, read (with line numbers), edit (append/prepend/replace lines/insert), delete |
| Scheduling | schedule one-shot or recurring tasks (cron + timezone), list, cancel |
| Status | set Aura's own Slack status with auto-expiration |
| Web | web_search (Tavily), read_url (content extraction) |
| Sandbox | run_command, read_sandbox_file, write_sandbox_file, read_own_source (E2B Linux VM) |

### Sandbox (Linux VM)

Aura has access to a persistent, sandboxed Linux VM via [E2B](https://e2b.dev). She can run any shell command, use git, run tests, write scripts, and more -- all in an isolated cloud environment.

- Pre-installed: git, node, python, gh (GitHub CLI), gcloud, vercel CLI, ripgrep, curl, jq
- Persistent: the sandbox state (files, installed packages) survives across conversations
- Paused between uses to save credits, resumed on demand (~1-2 seconds)
- Output is truncated to avoid token bloat
- Install additional tools on the fly with `apt-get install` or `pip install`

To use a custom template with more tools pre-installed:
```bash
npx e2b template init    # creates e2b.Dockerfile
# edit e2b.Dockerfile to add your tools
npx e2b template build   # returns a template ID
# set E2B_TEMPLATE_ID env var to the template ID
```

### Scheduling System

A 5-minute sweeper cron processes due scheduled actions. Everything -- reminders, morning routines, monitoring, follow-ups -- is a `schedule_action` call.

- **One-shot**: "Remind me in 2 hours to check the deploy"
- **Recurring**: Uses cron expressions with timezone support: `"0 9 * * 1-5"` + `"Europe/Zurich"`
- **Self-scheduling**: Aura can schedule her own follow-ups
- **Autonomous**: recurring actions carry `lastResult` forward for continuity
- **Resilient**: 3 retries with backoff, then DM escalation to the requester

### Settings UI

Admins can change models via the **Slack App Home tab** -- three dropdowns for Main, Fast, and Embedding models. Changes take effect on the next message, no redeploy needed. Settings are stored in the database.

### Slack Entity Resolution

Incoming messages are preprocessed to resolve Slack's encoded references (`<@U066V1AN6>` -> `@jonas (U066V1AN6)`). All tools accept both names and IDs, so the LLM can use either format.

---

## Project Structure

```
src/
  app.ts                      # Hono app, Slack events/interactions, signature verification
  index.ts                    # Local dev server entry point
  db/
    schema.ts                 # Drizzle schema (7 tables)
    client.ts                 # Neon + Drizzle client
    migrate.ts                # Programmatic migration runner
  lib/
    ai.ts                     # AI Gateway config + dynamic model resolution
    embeddings.ts             # embed() / embedMany() wrappers
    logger.ts                 # Structured logging
    metrics.ts                # Observability metrics
    privacy.ts                # DM privacy filtering
    settings.ts               # Settings CRUD (key-value in DB)
    sandbox.ts                # E2B sandbox lifecycle (create, pause, resume)
    files.ts                  # Slack file download (multimodal images)
    temporal.ts               # Time/date helpers
  memory/
    store.ts                  # Message + memory CRUD
    extract.ts                # LLM-based memory extraction
    retrieve.ts               # Semantic search via pgvector
    consolidate.ts            # Daily merge/decay cron logic
    transparency.ts           # "What do you know" / "forget X"
  personality/
    system-prompt.ts          # Personality + tools + self-awareness prompt
    anti-patterns.ts          # Post-processing: strip AI-isms
  pipeline/
    index.ts                  # Main orchestrator
    context.ts                # Parse Slack events + entity resolution
    prompt.ts                 # Assemble full LLM prompt
    respond.ts                # Call LLM with tools, post-process
  tools/
    slack.ts                  # Slack tools (channels, messages, reactions, users, canvases)
    lists.ts                  # Slack Lists write tools
    notes.ts                  # Agent scratchpad (CRUD with line-level editing)
    schedule.ts               # Scheduling tools (schedule, list, cancel actions)
    sandbox.ts                # E2B sandbox tools (shell, file read/write)
    web.ts                    # Web search (Tavily) and URL reading
  slack/
    formatter.ts              # Markdown -> Slack mrkdwn
    home.ts                   # App Home settings tab (Block Kit)
    handler.ts                # Alternative Bolt integration (reference)
  users/
    profiles.ts               # User profile CRUD + LLM-based updates
  cron/
    consolidate.ts            # Daily memory consolidation
    scheduler.ts              # 5-minute sweeper for scheduled actions
api/
  index.ts                    # Vercel entry (catch-all)
  health.ts                   # Health check
  slack/
    events.ts                 # Slack events entry
    interactions.ts           # Slack interactive payloads (App Home dropdowns)
  cron/
    consolidate.ts            # Memory consolidation cron entry
    scheduler.ts              # Scheduled actions sweeper entry
```

---

## How It Works

### Message flow

```
Slack event arrives
  -> POST /api/slack/events
  -> Acknowledge immediately (200 OK within 3 seconds)
  -> React with :eyes: (instant acknowledgment)
  -> Background: run pipeline
       1. Parse context (who, where, thread?)
       2. Resolve Slack entities (<@U...> -> @name (ID))
       3. Should we respond? (DMs: always. Channels: only if @mentioned)
       4. Retrieve memories (embed query -> pgvector similarity search)
       5. Fetch user profile (tone adaptation hints)
       6. Build system prompt (personality + architecture + tools + memories + profile + thread)
       7. Call LLM via AI Gateway (with tools + stopWhen for multi-step)
       8. Post-process (strip sycophantic openers, AI disclaimers)
       9. Format for Slack and send reply
      10. Background: store messages, extract memories, update profile
```

### Scheduling flow

```
User: "Check #bugs every weekday at 9 AM CET"
  -> LLM calls schedule_action tool
  -> Row inserted: cron="0 9 * * 1-5", tz="Europe/Zurich"

Every 5 minutes (sweeper cron):
  -> Query due actions (priority DESC, time ASC)
  -> For each: call generateText with all tools
  -> LLM reads channels, posts digests, escalates if urgent
  -> Mark completed, schedule next occurrence via cron-parser
  -> Carry lastResult forward for continuity
```

### Memory extraction

After every exchange, a fast-model LLM call extracts structured memories:

- **Facts** -- "The Q3 launch date is March 15"
- **Decisions** -- "We decided to use Postgres instead of MongoDB"
- **Personal** -- "Tom has a dog named Biscuit"
- **Relationships** -- "Joan and Maria work closely on mobile"
- **Sentiments** -- "Joan seemed frustrated about deploys"
- **Open threads** -- "Joan asked about API docs, no answer yet"

Each memory is embedded as a 1536-dimensional vector for semantic retrieval.

### Privacy

DM-sourced memories are **private by default**. They're only surfaced when:
- The current user is in the memory's `related_user_ids`, OR
- The user explicitly told Aura to share (e.g., "Tell Maria I approved the budget")

Channel messages are treated as shared knowledge.

### Memory consolidation

A daily cron job (4:00 AM UTC) runs:
- **Decay**: multiplies all relevance scores by 0.995 (~50% after 138 days)
- **Dedup**: finds memories with >95% cosine similarity, merges them
- Old memories are deprioritized but never deleted

---

## Switching Models

Change via the **App Home tab** in Slack (instant, no redeploy), or via env vars (requires redeploy).

Available models include Claude Opus 4.6, GPT-5.2, Gemini 3 Pro, and many more -- see the App Home dropdowns for the full catalog.

**Note on embedding dimensions:** The database schema uses 1536-dimensional vectors (matching `openai/text-embedding-3-small`). If you switch to an embedding model with different dimensions, you'll need to update the vector size in `src/db/schema.ts` and re-run the migration.

---

## Customizing Aura's Personality

The personality is defined in `src/personality/system-prompt.ts`. Key sections:

- **Who you are** -- core traits (direct, warm, concise, opinionated, witty, curious, self-aware)
- **How you communicate** -- formatting rules, energy matching
- **What you NEVER do** -- hard anti-patterns (no sycophancy, no disclaimers, no "delve")
- **How you disagree** -- push back with evidence, accept gracefully when overruled
- **How you use memory** -- reference naturally, don't force, be specific
- **How you work** -- architectural self-awareness (pipeline, runtime, memory system, scheduling)
- **Tools** -- full catalog of available actions with usage guidance

The anti-pattern post-processor in `src/personality/anti-patterns.ts` strips common AI-isms that leak through despite the prompt.

---

## Database Management

Migrations run automatically on every Vercel deploy via the `vercel-build` script.

```bash
npm run db:migrate        # Run migrations manually
npm run db:generate       # Generate a new migration after schema changes
npm run db:push           # Push schema directly (dev only)
npm run db:studio         # Browse the database
```

**Tables:** `messages`, `memories`, `user_profiles`, `channels`, `settings`, `notes`, `scheduled_actions`

---

## Local Development

```bash
npm run dev               # Start local server on http://localhost:3000
ngrok http 3000           # Tunnel for Slack events
npm run db:studio         # Browse the database
```

AI Gateway authenticates automatically via OIDC when deployed on Vercel. For local development, run `vercel env pull` or use `vercel dev`.

---

## Troubleshooting

**Aura doesn't respond to DMs**
- Check that `im:history` and `im:read` scopes are added
- Make sure `message.im` event subscription is enabled
- Verify `AURA_BOT_USER_ID` matches the bot's actual Slack user ID

**Aura doesn't respond to @mentions in channels**
- Invite Aura to the channel first (`/invite @Aura`)
- Check that `app_mention` event subscription is enabled

**"Invalid signature" in logs**
- Verify `SLACK_SIGNING_SECRET` matches the one in your Slack app's Basic Information page

**Slack shows "dispatch_failed" or retries events**
- Check Vercel function logs for errors
- Make sure all env vars are set in Vercel

**LLM calls fail with authentication errors**
- Make sure AI Gateway is enabled on your Vercel project
- For local dev, run `vercel env pull` or use `vercel dev`

**"Insufficient funds" errors**
- Top up your Vercel AI Gateway credits at vercel.com/~/ai

**Slack rate limiting warnings**
- The tools have built-in rate limiting (15 req/min) and caching
- If you still hit limits, reduce tool-heavy queries

**App Home tab not showing**
- Enable Home Tab in Slack app settings -> App Home
- Add `app_home_opened` to bot event subscriptions
- Make sure `AURA_ADMIN_USER_IDS` is set for edit access

---

## License

Private. Internal use only.

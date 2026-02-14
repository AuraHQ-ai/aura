# Aura v0

A Slack bot with persistent memory, personality, and cross-user awareness. Aura remembers every conversation, builds profiles of the people it talks to, and responds with a consistent, opinionated personality -- not like a tool, but like a colleague.

## What it does

- **Responds** in Slack DMs and channels (when @mentioned or addressed by name)
- **Remembers** everything -- facts, decisions, personal details, relationships, sentiments
- **Recalls** relevant context via semantic search across all past conversations
- **Adapts** its tone to each person's communication style
- **Respects privacy** -- DM content stays private unless explicitly shared
- **Forgets on request** -- users can ask "what do you know about me?" or say "forget X"

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js on Vercel (serverless functions) |
| Framework | [Hono](https://hono.dev) |
| LLM | [Vercel AI SDK 6](https://sdk.vercel.ai) via OpenAI (gpt-4o, gpt-4o-mini) |
| Embeddings | `text-embedding-3-small` (1536 dimensions) |
| Database | [Neon](https://neon.tech) PostgreSQL + pgvector |
| ORM | [Drizzle](https://orm.drizzle.team) |
| Slack | `@slack/web-api` + `@slack/bolt` (types) |

---

## Getting Started

There are three things to set up: a **Neon database**, a **Slack app**, and the **Vercel deployment**. The whole thing takes about 20 minutes.

### Prerequisites

- Node.js 20+
- A [Vercel](https://vercel.com) account
- A [Neon](https://neon.tech) account (free tier works)
- A [Slack](https://api.slack.com/apps) workspace where you can create apps
- An [OpenAI](https://platform.openai.com) API key

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

**Enable pgvector and create the schema:**

Open the **SQL Editor** in the Neon console (or connect with `psql`) and run the migration file:

```bash
# Option A: via psql
psql $DATABASE_URL -f src/db/migrations/0000_init.sql

# Option B: via Drizzle Kit (pushes schema from code)
npx drizzle-kit push
```

Option A runs the raw SQL migration directly. Option B uses Drizzle Kit to push the schema defined in `src/db/schema.ts`. Both produce the same result. Use whichever you prefer.

To verify it worked, run in the SQL editor:

```sql
SELECT tablename FROM pg_tables WHERE schemaname = 'public';
```

You should see: `messages`, `memories`, `user_profiles`, `channels`.

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
| `chat:write` | Send messages |
| `groups:history` | Read messages in private channels |
| `groups:read` | List private channels Aura is in |
| `im:history` | Read DM messages |
| `im:read` | Access DM channel info |
| `im:write` | Open DMs |
| `mpim:history` | Read group DM messages |
| `mpim:read` | Access group DM channel info |
| `users:read` | Look up user profiles (display name, timezone) |

#### Install to workspace

Still on **OAuth & Permissions**, click **Install to Workspace** and authorize. Copy the **Bot User OAuth Token** (`xoxb-...`) into `.env` as `SLACK_BOT_TOKEN`.

#### Signing secret

Go to **Basic Information** in the sidebar. Under **App Credentials**, copy the **Signing Secret** into `.env` as `SLACK_SIGNING_SECRET`.

#### Get the bot user ID

You need Aura's Slack user ID (starts with `U`). The easiest way:

1. Open Slack, find Aura in the member list
2. Click on its profile, click the three dots (**...**), click **Copy member ID**
3. Paste it into `.env` as `AURA_BOT_USER_ID`

Or via the API:

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  https://slack.com/api/auth.test | jq -r .user_id
```

#### Event subscriptions (do this after deploying -- see Step 5)

You'll come back to this after deployment. The event subscription URL needs to point to your live Vercel URL. Skip ahead to Step 4 and 5, then return here.

---

### Step 4: Set up OpenAI

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Create a new API key
3. Paste it into `.env` as `OPENAI_API_KEY`

**Models used:**

| Purpose | Model | Approximate cost |
|---|---|---|
| Conversation responses | `gpt-4o` | ~$2.50 / 1M input tokens |
| Memory extraction | `gpt-4o-mini` | ~$0.15 / 1M input tokens |
| Embeddings | `text-embedding-3-small` | ~$0.02 / 1M tokens |

You can change the models in `src/lib/ai.ts`.

**(Optional) Vercel AI Gateway:** If you want to route through Vercel's AI Gateway for caching, rate limiting, and observability, set `AI_GATEWAY_URL=https://gateway.ai.vercel.sh/v1` in `.env`. Otherwise leave it blank and calls go directly to OpenAI.

---

### Step 5: Deploy to Vercel

#### First deployment

```bash
# Install Vercel CLI if you haven't
npm i -g vercel

# Link to a Vercel project (creates one if it doesn't exist)
vercel link

# Set environment variables on Vercel
vercel env add DATABASE_URL           # paste your Neon connection string
vercel env add SLACK_BOT_TOKEN        # paste xoxb-...
vercel env add SLACK_SIGNING_SECRET   # paste signing secret
vercel env add OPENAI_API_KEY         # paste sk-...
vercel env add AURA_BOT_USER_ID      # paste U...
vercel env add CRON_SECRET            # make up a random string (protects the cron endpoint)

# Optionally:
vercel env add AI_GATEWAY_URL         # https://gateway.ai.vercel.sh/v1
vercel env add LOG_LEVEL              # info (or debug for more output)

# Deploy
vercel --prod
```

After deployment, note your production URL (e.g., `https://aura-xxx.vercel.app`).

#### Verify the deployment

```bash
curl https://aura-xxx.vercel.app/api/health
# Should return: {"ok":true,"timestamp":"..."}
```

---

### Step 6: Connect Slack to your deployment

Now go back to [api.slack.com/apps](https://api.slack.com/apps), select your Aura app, and set up event subscriptions.

1. Go to **Event Subscriptions** in the sidebar
2. Toggle **Enable Events** to ON
3. Set the **Request URL** to:

   ```
   https://aura-xxx.vercel.app/api/slack/events
   ```

   Slack will send a challenge request. Your app handles this automatically -- you should see a green checkmark.

4. Under **Subscribe to bot events**, add:

   | Event | Why |
   |---|---|
   | `message.im` | DM messages |
   | `message.channels` | Public channel messages |
   | `message.groups` | Private channel messages |
   | `app_mention` | @Aura mentions |

5. Click **Save Changes**

Slack may ask you to reinstall the app. Do so.

---

### Step 7: Talk to Aura

1. Open Slack and DM Aura. Say anything -- "Hey, what's up?"
2. Aura should respond within a few seconds
3. In a channel, invite Aura (type `/invite @Aura`) and then mention it: "@Aura what do you think about TypeScript?"

That's it. Aura is live.

---

## Local Development

For local development, you can run the Hono server directly:

```bash
npm run dev
```

This starts a local server on `http://localhost:3000`. To receive Slack events locally, you'll need a tunnel:

```bash
# Using ngrok
ngrok http 3000

# Or using Vercel CLI's dev mode (experimental)
vercel dev
```

Then update the Slack Event Subscriptions URL to point to your tunnel URL (`https://xxx.ngrok.io/api/slack/events`).

**Drizzle Studio** lets you browse the database:

```bash
npm run db:studio
```

---

## Project Structure

```
src/
  app.ts                      # Hono app, Slack endpoint, signature verification
  index.ts                    # Local dev server entry point
  db/
    schema.ts                 # Drizzle schema (4 tables)
    client.ts                 # Neon + Drizzle client
    migrations/0000_init.sql  # Raw SQL migration
  lib/
    ai.ts                     # OpenAI provider + model references
    embeddings.ts             # embed() / embedMany() wrappers
    logger.ts                 # Structured logging
    metrics.ts                # Observability metrics
    privacy.ts                # DM privacy filtering
    temporal.ts               # Time/date helpers
  memory/
    store.ts                  # Message + memory CRUD
    extract.ts                # LLM-based memory extraction
    retrieve.ts               # Semantic search via pgvector
    consolidate.ts            # Daily merge/decay cron logic
    transparency.ts           # "What do you know" / "forget X"
  personality/
    system-prompt.ts          # Aura's personality + prompt builder
    anti-patterns.ts          # Post-processing: strip AI-isms
  pipeline/
    index.ts                  # Main orchestrator
    context.ts                # Parse Slack events
    prompt.ts                 # Assemble full LLM prompt
    respond.ts                # Call LLM, post-process
  slack/
    formatter.ts              # Markdown -> Slack mrkdwn
    handler.ts                # Alternative Bolt integration (reference)
  users/
    profiles.ts               # User profile CRUD + LLM-based updates
  cron/
    consolidate.ts            # Vercel Cron handler
api/
  index.ts                    # Vercel entry (catch-all)
  health.ts                   # Health check
  slack/events.ts             # Slack events entry
  cron/consolidate.ts         # Cron entry
```

---

## How It Works

### Message flow

```
Slack event arrives
  -> POST /api/slack/events
  -> Acknowledge immediately (200 OK within 3 seconds)
  -> Background: run pipeline
       1. Parse context (who, where, thread?)
       2. Should we respond? (DMs: always. Channels: only if @mentioned)
       3. Retrieve memories (embed query -> pgvector similarity search)
       4. Fetch user profile (tone adaptation hints)
       5. Build system prompt (personality + memories + profile + thread)
       6. Call LLM (gpt-4o via AI SDK)
       7. Post-process (strip sycophantic openers, AI disclaimers)
       8. Format for Slack and send reply
       9. Background: store messages, extract memories, update profile
```

### Memory extraction

After every exchange, a separate LLM call (gpt-4o-mini) extracts structured memories:

- **Facts** -- "The Q3 launch date is March 15"
- **Decisions** -- "We decided to use Postgres instead of MongoDB"
- **Personal** -- "Tom has a dog named Biscuit"
- **Relationships** -- "Joan and Maria work closely on mobile"
- **Sentiments** -- "Joan seemed frustrated about deploys"
- **Open threads** -- "Joan asked about API docs, no answer yet"

Each memory is embedded and stored with its 1536-dimensional vector for semantic retrieval.

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

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Neon PostgreSQL connection string |
| `SLACK_BOT_TOKEN` | Yes | Slack bot token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Yes | Slack app signing secret |
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `AURA_BOT_USER_ID` | Yes | Slack user ID for the bot (`U...`) |
| `CRON_SECRET` | Recommended | Protects the `/api/cron/consolidate` endpoint |
| `AI_GATEWAY_URL` | No | Vercel AI Gateway URL for LLM routing |
| `LOG_LEVEL` | No | `debug`, `info` (default), `warn`, `error` |

---

## Customizing Aura's Personality

The personality is defined in `src/personality/system-prompt.ts`. It's a TypeScript template string, version-controlled, and deliberately editable. The key sections:

- **Who you are** -- core traits (direct, warm, concise, opinionated, witty, curious, self-aware)
- **How you communicate** -- formatting rules, energy matching
- **What you NEVER do** -- hard anti-patterns (no sycophancy, no disclaimers, no "delve")
- **How you disagree** -- push back with evidence, accept gracefully when overruled
- **How you use memory** -- reference naturally, don't force, be specific

The anti-pattern post-processor in `src/personality/anti-patterns.ts` acts as a safety net -- it strips common AI-isms that leak through despite the prompt.

---

## Changing Models

Edit `src/lib/ai.ts`:

```typescript
export const mainModel = openai("gpt-4o");       // conversation quality
export const fastModel = openai("gpt-4o-mini");  // extraction speed/cost
export const embeddingModel = openai.embedding("text-embedding-3-small");
```

You can swap to any model supported by the [AI SDK OpenAI provider](https://sdk.vercel.ai/providers/ai-sdk-providers/openai) -- including Claude via `@ai-sdk/anthropic` if you add that dependency.

---

## Database Management

```bash
# Push schema changes to the database
npm run db:push

# Generate a migration (if you prefer migration files)
npm run db:generate

# Open Drizzle Studio (database browser)
npm run db:studio
```

---

## Troubleshooting

**Aura doesn't respond to DMs**

- Check that `im:history` and `im:read` scopes are added
- Make sure the `message.im` event subscription is enabled
- Verify `AURA_BOT_USER_ID` matches the bot's actual Slack user ID

**Aura doesn't respond to @mentions in channels**

- Invite Aura to the channel first (`/invite @Aura`)
- Check that `app_mention` event subscription is enabled
- Check that `channels:history` and `chat:write` scopes are added

**"Invalid signature" in logs**

- Verify `SLACK_SIGNING_SECRET` matches the one in your Slack app's Basic Information page
- If using a tunnel (ngrok), make sure you're not double-proxying

**Slack shows "dispatch_failed" or retries events**

- This means the initial 200 OK wasn't received within 3 seconds
- Check Vercel function logs for startup errors
- Make sure all env vars are set in Vercel (not just locally)

**Memory retrieval returns nothing**

- Check that the `pgvector` extension is enabled: `SELECT * FROM pg_extension WHERE extname = 'vector';`
- Verify memories exist: `SELECT count(*) FROM memories WHERE embedding IS NOT NULL;`
- The HNSW index is created automatically by the migration

**High latency (>5 seconds)**

- Check Vercel function region -- deploy close to your Neon database region
- gpt-4o can take 2-4 seconds; this is normal
- Memory retrieval adds ~200-500ms for the embedding call

---

## License

Private. Internal use only.

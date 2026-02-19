---
name: aura-deployment
description: Deploy Aura to Vercel, manage environment variables, read logs, and configure the Slack app. Use when deploying, debugging production issues, adding env vars, checking logs, or managing the Vercel/Slack configuration.
---

# Aura Deployment

## Vercel CLI

The project uses `npx --yes vercel@50.13.2` (not globally installed). Always include `--scope realadvisor`.

## Pre-Push Checklist (CRITICAL)

Before pushing to main (which deploys to production immediately):

1. `npx tsc --noEmit` -- type check passes
2. **New npm packages?** Check if ESM-only. If yes, MUST use dynamic `import()` not static `import`. Static imports of ESM-only packages crash the entire Vercel function.
3. **New tools/features?** Verify they fail gracefully if their API key isn't set (return error message, don't crash)
4. **No secrets in code** -- use env vars, never hardcode

Lesson learned: A static `import` of the `e2b` package (which uses ESM-only `chalk`) crashed ALL of Aura on prod -- not just the sandbox feature. Every request failed. Dynamic import fixed it.

## Deploy

Push to `main` triggers auto-deploy. For manual deploy:

```bash
npx --yes vercel@50.13.2 --prod --scope realadvisor
```

## Environment Variables

**Add** (use `printf` to avoid trailing newlines):
```bash
printf '%s' 'the-value' | npx --yes vercel@50.13.2 env add VAR_NAME production --scope realadvisor
```

**List**:
```bash
npx --yes vercel@50.13.2 env ls --scope realadvisor
```

**Remove**:
```bash
npx --yes vercel@50.13.2 env rm VAR_NAME production --scope realadvisor --yes
```

After adding/removing env vars, redeploy for changes to take effect.

## Logs

**Stream runtime logs** (run with timeout, kill after):
```bash
npx --yes vercel@50.13.2 logs aura-alpha-five.vercel.app --scope realadvisor 2>&1 &
BGPID=$!
sleep 30
kill $BGPID 2>/dev/null
wait $BGPID 2>/dev/null
true
```

**Check deployment status**:
```bash
npx --yes vercel@50.13.2 ls --prod --scope realadvisor
```

**Build logs for a specific deployment**:
```bash
npx --yes vercel@50.13.2 inspect <deployment-url> --logs --scope realadvisor
```

## Current Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `SLACK_BOT_TOKEN` | Bot token (xoxb-...) |
| `SLACK_SIGNING_SECRET` | Slack signing secret |
| `AURA_BOT_USER_ID` | Bot's Slack user ID |
| `AURA_ADMIN_USER_IDS` | Comma-separated admin user IDs |
| `SLACK_USER_TOKEN` | User token for search (xoxp-...) |
| `CRON_SECRET` | Protects cron endpoints |
| `TAVILY_API_KEY` | Web search API key |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude Code in the sandbox |

## Slack App Configuration

Production URLs:
- Events: `https://aura-alpha-five.vercel.app/api/slack/events`
- Interactions: `https://aura-alpha-five.vercel.app/api/slack/interactions`
- Health: `https://aura-alpha-five.vercel.app/api/health`

After adding new scopes or events, reinstall the app at api.slack.com/apps.

## Direct API Investigation (POWERFUL)

When debugging Slack/GitHub integration issues, **call APIs directly with curl** using tokens from `.env` to see raw responses. This bypasses Aura's code and reveals undocumented fields, hidden metadata, and the true API response shape.

**Slack API** (source `.env` first for tokens):
```bash
source .env && curl -s -X POST 'https://slack.com/api/<METHOD>' \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"channel":"C...","limit":5}' | python3 -m json.tool
```

Use `$SLACK_USER_TOKEN` (xoxp-) for user-scoped methods (e.g. `search.messages`). Use `$SLACK_BOT_TOKEN` (xoxb-) for most other methods.

**GitHub API**:
```bash
source .env && curl -s -H "Authorization: token $GITHUB_TOKEN" \
  'https://api.github.com/repos/realadvisor/aura/pulls' | python3 -m json.tool
```

**Key lesson**: Slack's typed SDK and Aura's wrapper code can hide fields from the raw response. For example, `conversations.history` on a list channel returns `msg.slack_list.list_record_id` -- a direct record-to-thread mapping that the SDK types don't expose. Always check the raw JSON when something "doesn't exist" in the API.

## Quick Health Check

```bash
curl -s https://aura-alpha-five.vercel.app/api/health
```

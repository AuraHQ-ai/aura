---
name: aura-deployment
description: Deploy Aura to Vercel, manage environment variables, read logs, and configure the Slack app. Use when deploying, debugging production issues, adding env vars, checking logs, or managing the Vercel/Slack configuration.
---

# Aura Deployment

## Vercel CLI

The project uses `npx --yes vercel@50.13.2` (not globally installed). Always include `--scope real-advisor`.

## Deploy

Push to `main` triggers auto-deploy. For manual deploy:

```bash
npx --yes vercel@50.13.2 --prod --scope real-advisor
```

## Environment Variables

**Add** (use `printf` to avoid trailing newlines):
```bash
printf '%s' 'the-value' | npx --yes vercel@50.13.2 env add VAR_NAME production --scope real-advisor
```

**List**:
```bash
npx --yes vercel@50.13.2 env ls --scope real-advisor
```

**Remove**:
```bash
npx --yes vercel@50.13.2 env rm VAR_NAME production --scope real-advisor --yes
```

After adding/removing env vars, redeploy for changes to take effect.

## Logs

**Stream runtime logs** (run with timeout, kill after):
```bash
npx --yes vercel@50.13.2 logs aura-alpha-five.vercel.app --scope real-advisor 2>&1 &
BGPID=$!
sleep 30
kill $BGPID 2>/dev/null
wait $BGPID 2>/dev/null
true
```

**Check deployment status**:
```bash
npx --yes vercel@50.13.2 ls --prod --scope real-advisor
```

**Build logs for a specific deployment**:
```bash
npx --yes vercel@50.13.2 inspect <deployment-url> --logs --scope real-advisor
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

## Slack App Configuration

Production URLs:
- Events: `https://aura-alpha-five.vercel.app/api/slack/events`
- Interactions: `https://aura-alpha-five.vercel.app/api/slack/interactions`
- Health: `https://aura-alpha-five.vercel.app/api/health`

After adding new scopes or events, reinstall the app at api.slack.com/apps.

## Quick Health Check

```bash
curl -s https://aura-alpha-five.vercel.app/api/health
```

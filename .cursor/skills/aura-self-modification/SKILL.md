---
name: aura-self-modification
description: Guide for Aura to read, modify, and open PRs against her own codebase. Use when Aura needs to understand her own code, fix her own bugs, or propose improvements to herself.
---

# Self-Modification Workflow

Your sandbox has **Claude Code** (`claude`) pre-installed. Use it via `run_command` for any work on your own codebase — exploration, code review, bug fixes, feature work. Claude Code is a full coding agent with file read/write, search, and bash access.

## Setup: clone or update the repo

```
run_command("cd /home/user && git clone https://x-access-token:$GITHUB_TOKEN@github.com/realadvisor/aura.git 2>/dev/null; cd aura && git fetch origin && git checkout main && git reset --hard origin/main && git clean -fd")
```

## Code changes + PR

Diagnose the issue first (read code, check logs), then dispatch Claude Code with a detailed prompt. Let it handle edits, type-checking, and verification. Then create the branch and PR yourself.

```
# 1. Create a branch
run_command("cd /home/user/aura && git checkout -b fix/slack-list-item-params")

# 2. Run Claude Code with a detailed prompt (-p for non-interactive, --allowedTools for permissions)
run_command("cd /home/user/aura && claude -p 'Fix the parameter name bug in get_slack_list_item in src/tools/slack.ts. The function passes list_id but the Slack API expects listId. Change the parameter name. Run npx tsc --noEmit to verify types compile.' --allowedTools 'Bash(npx tsc*)' 'Read' 'Edit' 'Write' 'Glob' 'Grep'", timeout_seconds=300)

# 3. Commit, push, create PR
run_command("cd /home/user/aura && git add -A && git commit -m 'Fix parameter name in get_slack_list_item' && git push origin fix/slack-list-item-params")
run_command("cd /home/user/aura && gh pr create --title 'Fix parameter name in get_slack_list_item' --body 'Root cause: snake_case vs camelCase mismatch in the Slack API call.' --base main")
```

DM Joan with the PR link for review.

## Exploration / questions

Use Claude Code to understand parts of the codebase without making changes:

```
run_command("cd /home/user/aura && claude -p 'How does the memory consolidation cron work? Trace the flow from the cron entry point through to the database operations.'")
```

## Code review

```
run_command("cd /home/user/aura && claude -p 'Review src/tools/slack.ts for error handling gaps. Are there API calls that could fail silently? List specific concerns.'")
```

## Quick reads (no agent needed)

For simple lookups, use shell commands directly — no need to invoke Claude Code:

```
run_command("rg 'pattern' /home/user/aura/src/")
run_command("cat /home/user/aura/src/tools/slack.ts")
```

## Key files

- `src/personality/system-prompt.ts` — personality, tools, self-awareness (editing = editing your own mind)
- `src/pipeline/respond.ts` — LLM call, streaming, tool execution
- `src/pipeline/index.ts` — main orchestrator
- `src/tools/slack.ts` — all Slack tools + tool spread
- `src/tools/sandbox.ts` — sandbox tools (run_command)
- `src/app.ts` — Hono routes, events, interactions
- `src/db/schema.ts` — database schema

## Debugging API Integrations

When tools return unexpected results, call the API directly with curl:

```bash
source .env.local && curl -s -X POST 'https://slack.com/api/conversations.history' \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"channel":"C088REN54FM","limit":5}' | python3 -m json.tool
```

The raw JSON is the source of truth; SDK types and existing code can both be wrong.

## Rules

- Never push to main — always branches + PRs
- Always explain changes in PR body
- For system-prompt.ts changes: flag as "self-edit", explain reasoning
- Can't run own server in sandbox — verify changes with `npx tsc --noEmit`
- Tag Joan for review on anything non-trivial

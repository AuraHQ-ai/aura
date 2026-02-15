---
name: aura-self-modification
description: Guide for Aura to read, modify, and open PRs against her own codebase. Use when Aura needs to understand her own code, fix her own bugs, or propose improvements to herself.
---

# Self-Modification Workflow

## Quick read (no sandbox needed)

```
read_own_source("src/pipeline/respond.ts")
read_own_source("src/personality/system-prompt.ts")
```

## Full git workflow (in sandbox)

1. Clone: `git clone https://x-access-token:$GITHUB_TOKEN@github.com/realadvisor/aura.git /home/user/aura`
2. Branch: `cd /home/user/aura && git checkout -b <descriptive-name>`
3. Edit files with `write_sandbox_file` or `run_command` with sed
4. Commit: `cd /home/user/aura && git add -A && git commit -m "<clear message>"`
5. Push: `cd /home/user/aura && git push origin <branch>`
6. PR: `cd /home/user/aura && gh pr create --title "<title>" --body "<explanation>"`
7. DM Joan with the PR link for review

## Key files

- `src/personality/system-prompt.ts` -- Aura's personality, tools, self-awareness (editing = editing your own mind)
- `src/pipeline/respond.ts` -- LLM call, streaming, tool execution
- `src/pipeline/index.ts` -- main orchestrator
- `src/tools/slack.ts` -- all Slack tools + tool spread
- `src/tools/sandbox.ts` -- sandbox + read_own_source tools
- `src/app.ts` -- Hono routes, events, interactions
- `src/db/schema.ts` -- database schema

## Rules

- Never push to main -- always branches + PRs
- Always explain changes in PR body
- For system-prompt.ts changes: flag as "self-edit", explain reasoning
- Can't run own server in sandbox -- verify changes mentally
- Tag Joan for review on anything non-trivial

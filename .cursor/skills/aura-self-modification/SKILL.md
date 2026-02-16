---
name: aura-self-modification
description: Guide for Aura to read, modify, and open PRs against her own codebase. Use when Aura needs to understand her own code, fix her own bugs, or propose improvements to herself.
---

# Self-Modification Workflow

## Preferred: patch_own_code (Claude Agent SDK)

One tool call = one PR. Write a detailed prompt, get back a PR URL.

```
patch_own_code({
  prompt: "Fix the parameter name bug in get_slack_list_item in src/tools/slack.ts. The function passes 'list_id' but the Slack API expects 'listId'. Change line 423 to use the correct parameter name. Run npx tsc --noEmit to verify.",
  branch_name: "fix/slack-list-item-params",
  pr_title: "Fix parameter name in get_slack_list_item",
  pr_body: "Root cause: snake_case vs camelCase mismatch..."
})
```

The coding agent (Claude Agent SDK running in the E2B sandbox) handles: reading files, making edits, running type checks, committing, pushing, and creating the PR. You handle: diagnosis, prompt writing, and review.

**On failure:** The tool returns structured error info including the agent's last messages and any build output. Use this to either retry with a better prompt or fall back to manual workflow.

## Quick reads (no agent needed)

```
run_command("cat /home/user/aura/src/tools/slack.ts")
run_command("rg 'pattern' /home/user/aura/src/")
```

Clone the repo first if not already cloned:
```
run_command("git clone https://x-access-token:$GITHUB_TOKEN@github.com/realadvisor/aura.git /home/user/aura")
```

## Manual fallback (if patch_own_code is unavailable)

1. Clone: `git clone https://x-access-token:$GITHUB_TOKEN@github.com/realadvisor/aura.git /home/user/aura`
2. Branch: `cd /home/user/aura && git checkout -b <descriptive-name>`
3. Edit files with `run_command` using sed/heredocs
4. Commit: `cd /home/user/aura && git add -A && git commit -m "<clear message>"`
5. Push: `cd /home/user/aura && git push origin <branch>`
6. PR: `cd /home/user/aura && gh pr create --title "<title>" --body "<explanation>"`
7. DM Joan with the PR link for review

## Key files

- `src/personality/system-prompt.ts` -- Aura's personality, tools, self-awareness (editing = editing your own mind)
- `src/pipeline/respond.ts` -- LLM call, streaming, tool execution
- `src/pipeline/index.ts` -- main orchestrator
- `src/tools/slack.ts` -- all Slack tools + tool spread
- `src/tools/sandbox.ts` -- sandbox tools including patch_own_code
- `src/tools/agent-runner-template.mjs` -- the script that runs inside the sandbox to drive the Claude Agent SDK
- `src/app.ts` -- Hono routes, events, interactions
- `src/db/schema.ts` -- database schema

## Rules

- Never push to main -- always branches + PRs
- Always explain changes in PR body
- For system-prompt.ts changes: flag as "self-edit", explain reasoning
- Can't run own server in sandbox -- verify changes mentally
- Tag Joan for review on anything non-trivial

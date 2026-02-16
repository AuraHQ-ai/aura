#!/usr/bin/env node

/**
 * Agent runner script for the Claude Agent SDK.
 * Executed inside the E2B sandbox by the patch_own_code tool.
 *
 * Reads config from /home/user/agent-config.json:
 *   { prompt, branch_name, pr_title, pr_body? }
 *
 * Outputs a single JSON line to stdout with the result:
 *   { ok, pr_url?, summary?, cost_usd?, error?, agent_output? }
 */

import { readFileSync } from "fs";
import { execSync } from "child_process";

const REPO_DIR = "/home/user/aura";
const REPO_URL = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/realadvisor/aura.git`;

function run(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: opts.cwd || REPO_DIR,
    encoding: "utf-8",
    timeout: 30_000,
    stdio: opts.stdio || ["pipe", "pipe", "pipe"],
    ...opts,
  }).trim();
}

function shellEscape(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function output(result) {
  console.log(JSON.stringify(result));
}

async function main() {
  // ── Load config ──────────────────────────────────────────────────────
  let config;
  try {
    config = JSON.parse(readFileSync("/home/user/agent-config.json", "utf-8"));
  } catch (e) {
    output({ ok: false, error: `Failed to read agent-config.json: ${e.message}` });
    process.exit(1);
  }

  const { prompt, branch_name, pr_title, pr_body } = config;

  if (!prompt || !branch_name || !pr_title) {
    output({ ok: false, error: "Missing required config: prompt, branch_name, pr_title" });
    process.exit(1);
  }

  if (!/^[\w.\-/]+$/.test(branch_name)) {
    output({ ok: false, error: "Invalid branch_name: only alphanumeric, hyphens, dots, slashes, and underscores are allowed" });
    process.exit(1);
  }

  // ── Validate env ─────────────────────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    output({ ok: false, error: "ANTHROPIC_API_KEY not set in sandbox environment" });
    process.exit(1);
  }
  if (!process.env.GITHUB_TOKEN) {
    output({ ok: false, error: "GITHUB_TOKEN not set in sandbox environment" });
    process.exit(1);
  }

  // ── Clone or update repo ─────────────────────────────────────────────
  try {
    try {
      run(`git rev-parse --git-dir`, { cwd: REPO_DIR });
      // Repo exists -- fetch latest and reset to main
      run(`git fetch origin`);
      run(`git checkout main`);
      run(`git reset --hard origin/main`);
      run(`git clean -fd`);
    } catch {
      // No repo -- fresh clone
      run(`git clone ${REPO_URL} ${REPO_DIR}`, { cwd: "/home/user" });
    }
  } catch (e) {
    output({ ok: false, error: `Git setup failed: ${e.message}` });
    process.exit(1);
  }

  // ── Create branch ────────────────────────────────────────────────────
  try {
    // Delete local branch if it exists from a previous run
    try { run(`git branch -D ${shellEscape(branch_name)}`); } catch { /* ignore */ }
    run(`git checkout -b ${shellEscape(branch_name)}`);
  } catch (e) {
    output({ ok: false, error: `Branch creation failed: ${e.message}` });
    process.exit(1);
  }

  // ── Install SDK if needed ────────────────────────────────────────────
  try {
    run(`npm ls @anthropic-ai/claude-agent-sdk 2>/dev/null`, { cwd: "/home/user" });
  } catch {
    try {
      run(`npm install --prefix /home/user @anthropic-ai/claude-agent-sdk`, {
        cwd: "/home/user",
        timeout: 120_000,
      });
    } catch (e) {
      output({ ok: false, error: `SDK install failed: ${e.message}` });
      process.exit(1);
    }
  }

  // ── Run the coding agent ─────────────────────────────────────────────
  let agentResult = null;
  let agentMessages = [];

  try {
    const { query } = await import("/home/user/node_modules/@anthropic-ai/claude-agent-sdk/index.js");

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 270_000); // 4.5 min -- sandbox backstop is 5 min

    const systemPrompt = [
      "You are editing the Aura codebase (github.com/realadvisor/aura).",
      "TypeScript project with ESM ('type': 'module' in package.json). Uses .js extensions in imports.",
      "Vercel serverless runtime. AI SDK v6 (uses inputSchema, not parameters; stopWhen, not maxSteps).",
      "CRITICAL: Never use static imports for optional/external SDKs -- always use dynamic import().",
      "After making changes, run `npx tsc --noEmit` to verify types compile.",
      "Focus only on the code changes described in the prompt. Do not refactor unrelated code.",
    ].join("\n");

    const q = query({
      prompt,
      options: {
        cwd: REPO_DIR,
        systemPrompt,
        allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 50,
        maxBudgetUsd: 5.0,
        abortController,
      },
    });

    for await (const message of q) {
      if (message.type === "assistant") {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              agentMessages.push(block.text);
            }
          }
        }
      }
      if (message.type === "result") {
        agentResult = message;
      }
    }

    clearTimeout(timeout);
  } catch (e) {
    const lastMessages = agentMessages.slice(-3).join("\n---\n");
    output({
      ok: false,
      error: `Agent execution failed: ${e.message}`,
      agent_output: lastMessages || undefined,
    });
    process.exit(1);
  }

  // ── Check if agent made any changes ──────────────────────────────────
  const diff = run(`git diff --stat`);
  const untrackedCount = run(`git ls-files --others --exclude-standard | wc -l`).trim();

  if (!diff && untrackedCount === "0") {
    output({
      ok: false,
      error: "Agent completed but made no file changes.",
      agent_output: agentMessages.slice(-3).join("\n---\n") || undefined,
      cost_usd: agentResult?.total_cost_usd,
    });
    process.exit(1);
  }

  // ── Commit and push ──────────────────────────────────────────────────
  try {
    run(`git add -A`);
    const commitMsg = `${pr_title}\n\nAutomated patch by Aura via Claude Agent SDK.`;
    run(`git commit -m ${shellEscape(commitMsg)}`);
    run(`git push origin ${shellEscape(branch_name)} --force`, { timeout: 60_000 });
  } catch (e) {
    output({
      ok: false,
      error: `Git commit/push failed: ${e.message}`,
      agent_output: agentMessages.slice(-3).join("\n---\n") || undefined,
      cost_usd: agentResult?.total_cost_usd,
    });
    process.exit(1);
  }

  // ── Create PR ────────────────────────────────────────────────────────
  let prUrl;
  try {
    const body = pr_body || [
      "## Automated patch by Aura",
      "",
      "Dispatched via `patch_own_code` using the Claude Agent SDK.",
      "",
      "### Changes",
      diff,
      "",
      "### Agent summary",
      agentMessages.slice(-2).join("\n\n") || "(no summary)",
      "",
      `Cost: $${(agentResult?.total_cost_usd || 0).toFixed(4)}`,
    ].join("\n");

    prUrl = run(
      `gh pr create --title ${shellEscape(pr_title)} --body ${shellEscape(body)} --base main --head ${shellEscape(branch_name)}`,
      { timeout: 30_000 },
    );
  } catch (e) {
    // PR might already exist if re-running
    if (e.message?.includes("already exists")) {
      try {
        prUrl = run(`gh pr view ${shellEscape(branch_name)} --json url -q .url`);
      } catch {
        prUrl = "(PR exists but could not retrieve URL)";
      }
    } else {
      output({
        ok: false,
        error: `PR creation failed: ${e.message}`,
        agent_output: agentMessages.slice(-3).join("\n---\n") || undefined,
        cost_usd: agentResult?.total_cost_usd,
      });
      process.exit(1);
    }
  }

  // ── Success ──────────────────────────────────────────────────────────
  output({
    ok: true,
    pr_url: prUrl,
    summary: agentMessages.slice(-2).join("\n\n") || "(no summary)",
    diff_stat: diff,
    cost_usd: agentResult?.total_cost_usd || 0,
    num_turns: agentResult?.num_turns || 0,
  });
}

main().catch((e) => {
  output({ ok: false, error: `Unexpected error: ${e.message}` });
  process.exit(1);
});

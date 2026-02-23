import { Hono } from "hono";
import { waitUntil } from "@vercel/functions";
import crypto from "node:crypto";
import { logger } from "../lib/logger.js";
import { recordError } from "../lib/metrics.js";
import { claimEvent } from "../memory/store.js";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes } from "../db/schema.js";

// ── Config ──────────────────────────────────────────────────────────────────

const REPO = "realadvisor/aura";
const OUR_BRANCH_PREFIXES = ["cursor/", "claude/"];
const OUR_BOT_AUTHORS = ["aura[bot]"];

export const githubWebhookApp = new Hono();

// ── Signature Verification ──────────────────────────────────────────────────

function verifyGitHubSignature(
  rawBody: string,
  signature: string,
): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !signature) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(signature, "utf8"),
    );
  } catch {
    return false;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isOurBranch(branchName: string): boolean {
  return OUR_BRANCH_PREFIXES.some((p) => branchName.startsWith(p));
}

function isOurPR(pr: { head?: { ref?: string }; user?: { login?: string } }): boolean {
  const branch = pr.head?.ref || "";
  const author = pr.user?.login || "";
  return isOurBranch(branch) || OUR_BOT_AUTHORS.includes(author);
}

async function getGitHubToken(): Promise<string | null> {
  const { getCredential } = await import("../lib/credentials.js");
  return getCredential("github_token");
}

async function getSlackClient() {
  const { WebClient } = await import("@slack/web-api");
  return new WebClient(process.env.SLACK_BOT_TOKEN || "");
}

let _authenticatedGitHubLogin: string | null | undefined;

async function getAuthenticatedGitHubLogin(): Promise<string | null> {
  if (_authenticatedGitHubLogin !== undefined) return _authenticatedGitHubLogin;
  const ghToken = await getGitHubToken();
  if (!ghToken) {
    _authenticatedGitHubLogin = null;
    return null;
  }
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `token ${ghToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (res.ok) {
      const user = (await res.json()) as { login: string };
      _authenticatedGitHubLogin = user.login;
      return user.login;
    }
  } catch {}
  _authenticatedGitHubLogin = null;
  return null;
}

async function isBotComment(comment: {
  user?: { login?: string; type?: string };
}): Promise<boolean> {
  const login = comment.user?.login || "";
  if (!login) return false;
  if (OUR_BOT_AUTHORS.includes(login)) return true;
  if (comment.user?.type === "Bot") return true;
  const botLogin = await getAuthenticatedGitHubLogin();
  return botLogin !== null && login === botLogin;
}

/**
 * Look up the Slack user who originally requested a Cursor agent dispatch,
 * searching tracking notes by branch name.
 */
async function findRequesterByBranch(
  branchName: string,
): Promise<{ requester: string; channelId: string; threadTs: string } | null> {
  try {
    const rows = await db
      .select({ topic: notes.topic, content: notes.content })
      .from(notes)
      .where(eq(notes.category, "plan"))
      .limit(50);

    for (const row of rows) {
      if (!row.topic.startsWith("cursor-agent:")) continue;
      if (!row.content.includes(branchName)) continue;

      const requesterMatch = row.content.match(/\*\*Requester\*\*:\s*(\S+)/);
      const channelMatch = row.content.match(/\*\*Channel\*\*:\s*(\S+)/);
      const threadMatch = row.content.match(/\*\*Thread\*\*:\s*(\S+)/);

      const requester = requesterMatch?.[1];
      if (requester && requester !== "unknown") {
        return {
          requester,
          channelId: channelMatch?.[1] || "",
          threadTs: threadMatch?.[1] || "",
        };
      }
    }
  } catch (err) {
    logger.warn("findRequesterByBranch: failed", { branchName, error: String(err) });
  }
  return null;
}

async function dmUser(userId: string, text: string): Promise<void> {
  try {
    const slack = await getSlackClient();
    const dm = await slack.conversations.open({ users: userId });
    if (dm.channel?.id) {
      await slack.chat.postMessage({ channel: dm.channel.id, text });
    }
  } catch (err) {
    logger.error("dmUser failed", { userId, error: String(err) });
  }
}

// ── LLM Helpers ─────────────────────────────────────────────────────────────

async function callTriageLLM(prompt: string): Promise<string> {
  const { getFastModel } = await import("../lib/ai.js");
  const { generateText } = await import("ai");
  const model = await getFastModel();

  const { text } = await generateText({
    model,
    maxOutputTokens: 500,
    prompt,
  });
  return text.trim();
}

// ── PR Review Comment Handler ───────────────────────────────────────────────

async function handlePRReviewComment(payload: any): Promise<void> {
  const pr = payload.pull_request;
  const comment = payload.comment;

  if (!pr || !comment) return;

  if (!isOurPR(pr)) {
    logger.debug("GitHub webhook: PR review comment on non-agent PR, ignoring", {
      pr: pr.number,
      branch: pr.head?.ref,
    });
    return;
  }

  if (await isBotComment(comment)) {
    logger.debug("GitHub webhook: ignoring bot's own PR comment", {
      pr: pr.number,
      author: comment.user?.login,
    });
    return;
  }

  const branchName = pr.head?.ref || "";
  const filePath = comment.path || "";
  const line = comment.line || comment.original_line || 0;
  const diffHunk = comment.diff_hunk || "";
  const commentBody = comment.body || "";
  const commentAuthor = comment.user?.login || "unknown";
  const prTitle = pr.title || "";
  const prNumber = pr.number;
  const commentId = comment.id;

  logger.info("GitHub webhook: processing PR review comment", {
    pr: prNumber,
    branch: branchName,
    file: filePath,
    line,
    author: commentAuthor,
  });

  const triagePrompt = `You are triaging a code review comment on a pull request created by an automated agent.

PR #${prNumber}: ${prTitle}
Branch: ${branchName}
File: ${filePath}
Line: ${line}

Diff context:
\`\`\`
${diffHunk.slice(0, 1000)}
\`\`\`

Review comment by ${commentAuthor}:
"${commentBody.slice(0, 2000)}"

Decide what action to take:
- "fix_needed" — the comment points out a real bug, style issue, or necessary change that should be fixed in code
- "reply" — the comment is a question, acknowledgment, or discussion point that should be answered but doesn't require code changes. Include the reply text after a pipe character.
- "ignore" — the comment is noise, a bot comment, or already addressed

Respond with EXACTLY one of:
fix_needed
reply|<your reply text>
ignore`;

  try {
    const decision = await callTriageLLM(triagePrompt);
    logger.info("GitHub webhook: PR comment triage result", {
      pr: prNumber,
      decision: decision.slice(0, 100),
    });

    if (decision.startsWith("fix_needed")) {
      const { launchCursorAgent } = await import("../lib/cursor-agent.js");

      const fixPrompt = `A code review comment was left on PR #${prNumber} (branch: ${branchName}).

File: ${filePath}
Line: ${line}

Diff context:
\`\`\`
${diffHunk.slice(0, 2000)}
\`\`\`

Review comment by ${commentAuthor}:
"${commentBody}"

Please fix the issue described in this review comment. Make the minimal change needed to address the feedback. Commit and push to the same branch (${branchName}).`;

      const result = await launchCursorAgent({
        prompt: fixPrompt,
        repository: `https://github.com/${REPO}`,
        ref: branchName,
        branchName,
        autoCreatePr: false,
      });

      logger.info("GitHub webhook: dispatched Cursor agent for PR comment fix", {
        agentId: result.id,
        pr: prNumber,
        branch: branchName,
      });

      const tracking = findRequesterByBranch(branchName);
      const info = await tracking;
      if (info?.requester) {
        await dmUser(
          info.requester,
          `💬 Review comment on <https://github.com/${REPO}/pull/${prNumber}|PR #${prNumber}> by ${commentAuthor}:\n> ${commentBody.slice(0, 300)}\n\nI've dispatched an agent to fix it.`,
        );
      }
    } else if (decision.startsWith("reply|")) {
      const replyText = decision.slice("reply|".length).trim();
      if (replyText) {
        const ghToken = await getGitHubToken();
        if (ghToken) {
          const res = await fetch(
            `https://api.github.com/repos/${REPO}/pulls/${prNumber}/comments/${commentId}/replies`,
            {
              method: "POST",
              headers: {
                Authorization: `token ${ghToken}`,
                Accept: "application/vnd.github.v3+json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ body: replyText }),
            },
          );
          if (!res.ok) {
            const errText = await res.text();
            logger.warn("GitHub webhook: failed to post PR comment reply", {
              status: res.status,
              error: errText.slice(0, 500),
            });
          }
        }
      }

      const info = await findRequesterByBranch(branchName);
      if (info?.requester) {
        await dmUser(
          info.requester,
          `💬 Review comment on <https://github.com/${REPO}/pull/${prNumber}|PR #${prNumber}> by ${commentAuthor}:\n> ${commentBody.slice(0, 300)}\n\nI replied on the PR.`,
        );
      }
    } else {
      logger.debug("GitHub webhook: ignoring PR review comment", { pr: prNumber });
    }
  } catch (err) {
    recordError("github_webhook.pr_review_comment", err, {
      pr: prNumber,
      branch: branchName,
    });
  }
}

// ── Check Run Failure Handler ───────────────────────────────────────────────

async function handleCheckRunFailure(payload: any): Promise<void> {
  const checkRun = payload.check_run;
  if (!checkRun) return;

  if (checkRun.conclusion !== "failure") return;

  const prs = checkRun.pull_requests || [];
  if (prs.length === 0) {
    logger.debug("GitHub webhook: check_run failure with no associated PRs");
    return;
  }

  for (const pr of prs) {
    const branchName = pr.head?.ref || "";
    if (!isOurBranch(branchName)) {
      logger.debug("GitHub webhook: check_run failure on non-agent branch", {
        branch: branchName,
      });
      continue;
    }

    const checkName = checkRun.name || "CI";
    const prNumber = pr.number;
    const detailsUrl = checkRun.details_url || checkRun.html_url || "";

    logger.info("GitHub webhook: processing CI failure", {
      pr: prNumber,
      branch: branchName,
      check: checkName,
    });

    try {
      let jobLogs = "";
      const ghToken = await getGitHubToken();
      if (ghToken && checkRun.id) {
        try {
          const logsRes = await fetch(
            `https://api.github.com/repos/${REPO}/actions/jobs/${checkRun.id}/logs`,
            {
              headers: {
                Authorization: `token ${ghToken}`,
                Accept: "application/vnd.github.v3+json",
              },
              redirect: "follow",
            },
          );
          if (logsRes.ok) {
            const fullLogs = await logsRes.text();
            // Take the last portion of logs (most relevant for failures)
            jobLogs = fullLogs.slice(-4000);
          }
        } catch (logErr) {
          logger.warn("GitHub webhook: failed to fetch job logs", {
            error: String(logErr),
          });
        }
      }

      const diagPrompt = `You are diagnosing a CI failure on a pull request created by an automated coding agent.

PR #${prNumber}
Branch: ${branchName}
Failed check: ${checkName}
${detailsUrl ? `Details: ${detailsUrl}` : ""}

${jobLogs ? `Job logs (last ~4000 chars):\n\`\`\`\n${jobLogs}\n\`\`\`` : "No job logs available."}

Analyze this CI failure and decide:
- "auto_fixable" — the failure is a straightforward code issue (type error, lint error, missing import, test failure with obvious fix) that an AI agent can fix. Include a brief description of the fix needed after a pipe character.
- "needs_human" — the failure requires human judgment (infrastructure issue, flaky test, credentials problem, complex architectural issue). Include a brief diagnosis after a pipe character.

Respond with EXACTLY one of:
auto_fixable|<description of fix needed>
needs_human|<diagnosis>`;

      const decision = await callTriageLLM(diagPrompt);
      logger.info("GitHub webhook: CI failure triage result", {
        pr: prNumber,
        decision: decision.slice(0, 100),
      });

      if (decision.startsWith("auto_fixable|")) {
        const claimed = await claimEvent(`ci-fix:${branchName}:${checkName}`, "github");
        if (!claimed) {
          logger.info("GitHub webhook: CI fix already dispatched, skipping", {
            branch: branchName,
            check: checkName,
          });
          continue;
        }

        const fixDescription = decision.slice("auto_fixable|".length).trim();
        const { launchCursorAgent } = await import("../lib/cursor-agent.js");

        const fixPrompt = `CI check "${checkName}" failed on PR #${prNumber} (branch: ${branchName}).

Diagnosis: ${fixDescription}

${jobLogs ? `Relevant logs:\n\`\`\`\n${jobLogs.slice(-2000)}\n\`\`\`` : ""}

Please fix the CI failure. Run the failing checks locally to verify your fix before committing. Push to the same branch (${branchName}).`;

        const result = await launchCursorAgent({
          prompt: fixPrompt,
          repository: `https://github.com/${REPO}`,
          ref: branchName,
          branchName,
          autoCreatePr: false,
        });

        logger.info("GitHub webhook: dispatched Cursor agent for CI fix", {
          agentId: result.id,
          pr: prNumber,
          branch: branchName,
          check: checkName,
        });

        const info = await findRequesterByBranch(branchName);
        if (info?.requester) {
          await dmUser(
            info.requester,
            `🔴 CI failed on <https://github.com/${REPO}/pull/${prNumber}|PR #${prNumber}> (${checkName}):\n> ${fixDescription.slice(0, 300)}\n\nI've dispatched an agent to fix it.`,
          );
        }
      } else if (decision.startsWith("needs_human|")) {
        const diagnosis = decision.slice("needs_human|".length).trim();

        const info = await findRequesterByBranch(branchName);
        if (info?.requester) {
          await dmUser(
            info.requester,
            `🔴 CI failed on <https://github.com/${REPO}/pull/${prNumber}|PR #${prNumber}> (${checkName}):\n> ${diagnosis.slice(0, 500)}\n\nThis looks like it needs human attention.${detailsUrl ? `\n<${detailsUrl}|View details>` : ""}`,
          );
        } else {
          const adminIds = (process.env.AURA_ADMIN_USER_IDS || "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
          if (adminIds[0]) {
            await dmUser(
              adminIds[0],
              `🔴 CI failed on <https://github.com/${REPO}/pull/${prNumber}|PR #${prNumber}> (${checkName}, branch: ${branchName}):\n> ${diagnosis.slice(0, 500)}\n\nNeeds human attention.${detailsUrl ? `\n<${detailsUrl}|View details>` : ""}`,
            );
          }
        }
      }
    } catch (err) {
      recordError("github_webhook.check_run_failure", err, {
        pr: prNumber,
        branch: branchName,
        check: checkName,
      });
    }
  }
}

// ── Webhook Endpoint ────────────────────────────────────────────────────────

githubWebhookApp.post("/api/webhook/github", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") || "";

  if (!process.env.GITHUB_WEBHOOK_SECRET) {
    logger.warn("GITHUB_WEBHOOK_SECRET not configured — rejecting webhook");
    return c.json({ error: "Webhook not configured" }, 403);
  }

  if (!verifyGitHubSignature(rawBody, signature)) {
    logger.warn("Invalid GitHub webhook signature — rejecting");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const event = c.req.header("x-github-event") || "";
  const deliveryId = c.req.header("x-github-delivery") || "";
  const action = payload.action || "";

  logger.info("GitHub webhook event", { event, action, deliveryId });

  if (event === "pull_request_review_comment" && action === "created") {
    const processPromise = handlePRReviewComment(payload).catch((err) => {
      recordError("github_webhook.pr_review_comment", err, { deliveryId });
    });
    waitUntil(processPromise);
  } else if (event === "check_run" && action === "completed") {
    const processPromise = handleCheckRunFailure(payload).catch((err) => {
      recordError("github_webhook.check_run", err, { deliveryId });
    });
    waitUntil(processPromise);
  } else {
    logger.debug("GitHub webhook: unhandled event", { event, action });
  }

  return c.json({ ok: true });
});

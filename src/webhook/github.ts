import { Hono } from "hono";
import { waitUntil } from "@vercel/functions";
import { WebClient } from "@slack/web-api";
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import crypto from "node:crypto";
import { like } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes } from "../db/schema.js";
import { getFastModel } from "../lib/ai.js";
import { getCredential } from "../lib/credentials.js";
import { createSlackTools } from "../tools/slack.js";
import { logger } from "../lib/logger.js";
import { recordError } from "../lib/metrics.js";
import { claimEvent } from "../memory/store.js";

// ── Config ──────────────────────────────────────────────────────────────────

const botToken = process.env.SLACK_BOT_TOKEN || "";
const slackClient = new WebClient(botToken);

const GITHUB_BOT_USER = "aura-vidal";

const HANDLED_PR_ACTIONS = new Set([
  "opened",
  "closed",
  "reopened",
  "synchronize",
  "ready_for_review",
]);

const HANDLED_CHECK_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
]);

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

// ── GitHub API Helpers ──────────────────────────────────────────────────────

async function githubFetch(
  path: string,
  options?: { accept?: string },
): Promise<Response> {
  const token = await getCredential("github_token");
  if (!token) throw new Error("GitHub token not configured");

  return fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: options?.accept || "application/vnd.github.v3+json",
      "User-Agent": "aura-webhook",
    },
  });
}

async function fetchPRDiff(owner: string, repo: string, number: number): Promise<string> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/pulls/${number}`,
    { accept: "application/vnd.github.diff" },
  );
  if (!res.ok) return `[Failed to fetch diff: HTTP ${res.status}]`;
  const diff = await res.text();
  if (diff.length > 30_000) {
    return diff.slice(0, 30_000) + "\n\n... [diff truncated at 30KB]";
  }
  return diff;
}

async function fetchPRDetails(
  owner: string,
  repo: string,
  number: number,
): Promise<any> {
  const res = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}`);
  if (!res.ok) return null;
  return res.json();
}

async function fetchCheckRunLogs(
  owner: string,
  repo: string,
  checkRunId: number,
): Promise<string> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/check-runs/${checkRunId}`,
  );
  if (!res.ok) return `[Failed to fetch check run: HTTP ${res.status}]`;
  const data = (await res.json()) as any;
  const output = data.output;
  if (!output) return "[No output available]";
  const parts: string[] = [];
  if (output.title) parts.push(`Title: ${output.title}`);
  if (output.summary) parts.push(`Summary: ${output.summary}`);
  if (output.text) {
    const text = output.text.length > 10_000
      ? output.text.slice(0, 10_000) + "\n... [truncated]"
      : output.text;
    parts.push(`Details:\n${text}`);
  }
  return parts.join("\n\n") || "[Empty output]";
}

// ── Tracking Note Lookup ────────────────────────────────────────────────────

interface TrackingInfo {
  requester: string | null;
  channelId: string | null;
  threadTs: string | null;
  agentId: string | null;
}

async function lookupTrackingInfo(
  searchTerms: string[],
): Promise<TrackingInfo> {
  const result: TrackingInfo = {
    requester: null,
    channelId: null,
    threadTs: null,
    agentId: null,
  };

  try {
    const rows = await db
      .select({ topic: notes.topic, content: notes.content })
      .from(notes)
      .where(like(notes.topic, "cursor-agent:%"))
      .limit(100);

    for (const row of rows) {
      const matches = searchTerms.some(
        (term) => row.content.includes(term),
      );
      if (!matches) continue;

      const agentMatch = row.topic.match(/^cursor-agent:(.+)$/);
      if (agentMatch) result.agentId = agentMatch[1];

      const requesterMatch = row.content.match(
        /\*\*Requester\*\*:\s*(\S+)/,
      );
      if (requesterMatch && requesterMatch[1] !== "unknown") {
        result.requester = requesterMatch[1];
      }
      const channelMatch = row.content.match(/\*\*Channel\*\*:\s*(\S+)/);
      if (channelMatch && channelMatch[1] !== "unknown") {
        result.channelId = channelMatch[1];
      }
      const threadMatch = row.content.match(/\*\*Thread\*\*:\s*(\S+)/);
      if (threadMatch && threadMatch[1] !== "none") {
        result.threadTs = threadMatch[1];
      }
      break;
    }
  } catch (err) {
    logger.error("lookupTrackingInfo failed", { error: err });
  }

  return result;
}

function isOurPR(payload: any): boolean {
  const author = payload.pull_request?.user?.login;
  return author === GITHUB_BOT_USER;
}

function isOurIssue(payload: any): boolean {
  const author = payload.issue?.user?.login;
  return author === GITHUB_BOT_USER;
}

// ── Context Gathering ───────────────────────────────────────────────────────

async function gatherPRContext(payload: any): Promise<string> {
  const pr = payload.pull_request;
  const action = payload.action;
  const repo = payload.repository;
  const [owner, repoName] = repo.full_name.split("/");
  const number = pr.number;

  const parts: string[] = [
    `## GitHub Event: pull_request (${action})`,
    ``,
    `**PR #${number}**: ${pr.title}`,
    `**Author**: ${pr.user.login}`,
    `**Branch**: ${pr.head.ref} → ${pr.base.ref}`,
    `**State**: ${pr.state}${pr.merged ? " (merged)" : ""}${pr.draft ? " (draft)" : ""}`,
    `**URL**: ${pr.html_url}`,
    `**Repo**: ${repo.full_name}`,
  ];

  if (pr.body) {
    parts.push(``, `**Description**:`, pr.body.slice(0, 2000));
  }

  const tracking = await lookupTrackingInfo([
    pr.html_url,
    pr.head.ref,
    `#${number}`,
  ]);

  parts.push(``, `## Tracking`);
  parts.push(`- Is our PR: ${isOurPR(payload) ? "yes" : "no"}`);
  if (tracking.requester)
    parts.push(`- Slack requester: ${tracking.requester}`);
  if (tracking.channelId)
    parts.push(`- Slack channel: ${tracking.channelId}`);
  if (tracking.threadTs)
    parts.push(`- Slack thread: ${tracking.threadTs}`);
  if (tracking.agentId)
    parts.push(`- Cursor agent: ${tracking.agentId}`);

  if (action !== "closed") {
    try {
      const diff = await fetchPRDiff(owner, repoName, number);
      parts.push(``, `## Diff`, "```", diff, "```");
    } catch {
      parts.push(``, `[Could not fetch diff]`);
    }
  }

  return parts.join("\n");
}

async function gatherCheckRunContext(payload: any): Promise<string> {
  const checkRun = payload.check_run;
  const repo = payload.repository;
  const [owner, repoName] = repo.full_name.split("/");

  const parts: string[] = [
    `## GitHub Event: check_run (${payload.action})`,
    ``,
    `**Check**: ${checkRun.name}`,
    `**Conclusion**: ${checkRun.conclusion}`,
    `**Status**: ${checkRun.status}`,
    `**URL**: ${checkRun.html_url}`,
    `**Repo**: ${repo.full_name}`,
  ];

  const prList = checkRun.pull_requests || [];
  if (prList.length > 0) {
    const prNum = prList[0].number;
    parts.push(`**Associated PR**: #${prNum}`);

    const prDetails = await fetchPRDetails(owner, repoName, prNum);
    if (prDetails) {
      parts.push(`**PR Title**: ${prDetails.title}`);
      parts.push(`**PR Author**: ${prDetails.user?.login}`);
      parts.push(`**PR Branch**: ${prDetails.head?.ref}`);
      parts.push(`**PR URL**: ${prDetails.html_url}`);

      const tracking = await lookupTrackingInfo([
        prDetails.html_url,
        prDetails.head?.ref,
        `#${prNum}`,
      ].filter((t): t is string => t != null));

      const isOurs = prDetails.user?.login === GITHUB_BOT_USER;
      parts.push(``, `## Tracking`);
      parts.push(`- Is our PR: ${isOurs ? "yes" : "no"}`);
      if (tracking.requester) parts.push(`- Slack requester: ${tracking.requester}`);
      if (tracking.channelId) parts.push(`- Slack channel: ${tracking.channelId}`);
      if (tracking.threadTs) parts.push(`- Slack thread: ${tracking.threadTs}`);
      if (tracking.agentId) parts.push(`- Cursor agent: ${tracking.agentId}`);
    }
  }

  try {
    const logs = await fetchCheckRunLogs(owner, repoName, checkRun.id);
    parts.push(``, `## Check Run Output`, logs);
  } catch {
    parts.push(``, `[Could not fetch check run logs]`);
  }

  return parts.join("\n");
}

async function gatherPRReviewCommentContext(payload: any): Promise<string> {
  const comment = payload.comment;
  const pr = payload.pull_request;
  const repo = payload.repository;
  const [owner, repoName] = repo.full_name.split("/");
  const number = pr.number;

  const parts: string[] = [
    `## GitHub Event: pull_request_review_comment (${payload.action})`,
    ``,
    `**PR #${number}**: ${pr.title}`,
    `**PR Author**: ${pr.user.login}`,
    `**PR URL**: ${pr.html_url}`,
    `**Comment by**: ${comment.user.login}`,
    `**Comment ID**: ${comment.id}`,
    `**File**: ${comment.path}`,
    `**Line**: ${comment.line || comment.original_line || "N/A"}`,
    `**Comment URL**: ${comment.html_url}`,
    `**Repo**: ${repo.full_name}`,
  ];

  if (comment.diff_hunk) {
    parts.push(``, `## Diff Hunk`, "```", comment.diff_hunk, "```");
  }

  parts.push(``, `## Comment`, comment.body);

  const tracking = await lookupTrackingInfo([
    pr.html_url,
    pr.head?.ref,
    `#${number}`,
  ].filter((t): t is string => t != null));

  parts.push(``, `## Tracking`);
  parts.push(`- Is our PR: ${isOurPR(payload) ? "yes" : "no"}`);
  if (tracking.requester) parts.push(`- Slack requester: ${tracking.requester}`);
  if (tracking.channelId) parts.push(`- Slack channel: ${tracking.channelId}`);
  if (tracking.threadTs) parts.push(`- Slack thread: ${tracking.threadTs}`);
  if (tracking.agentId) parts.push(`- Cursor agent: ${tracking.agentId}`);

  try {
    const diff = await fetchPRDiff(owner, repoName, number);
    parts.push(``, `## Full PR Diff`, "```", diff, "```");
  } catch {
    parts.push(``, `[Could not fetch full PR diff]`);
  }

  return parts.join("\n");
}

async function gatherIssueCommentContext(payload: any): Promise<string> {
  const comment = payload.comment;
  const issue = payload.issue;
  const repo = payload.repository;

  const parts: string[] = [
    `## GitHub Event: issue_comment (${payload.action})`,
    ``,
    `**Issue #${issue.number}**: ${issue.title}`,
    `**Issue Author**: ${issue.user.login}`,
    `**Issue State**: ${issue.state}`,
    `**Issue URL**: ${issue.html_url}`,
    `**Comment by**: ${comment.user.login}`,
    `**Comment URL**: ${comment.html_url}`,
    `**Repo**: ${repo.full_name}`,
  ];

  if (issue.body) {
    parts.push(``, `## Issue Body`, issue.body.slice(0, 2000));
  }

  parts.push(``, `## Comment`, comment.body);

  parts.push(``, `## Tracking`);
  parts.push(`- Is our issue: ${isOurIssue(payload) ? "yes" : "no"}`);

  if (issue.pull_request) {
    parts.push(`- This is a PR comment (issue is a pull request)`);
    const tracking = await lookupTrackingInfo([
      issue.html_url,
      `#${issue.number}`,
    ]);
    if (tracking.requester) parts.push(`- Slack requester: ${tracking.requester}`);
    if (tracking.channelId) parts.push(`- Slack channel: ${tracking.channelId}`);
    if (tracking.threadTs) parts.push(`- Slack thread: ${tracking.threadTs}`);
    if (tracking.agentId) parts.push(`- Cursor agent: ${tracking.agentId}`);
  }

  return parts.join("\n");
}

async function gatherPushContext(payload: any): Promise<string> {
  const repo = payload.repository;
  const ref = payload.ref;
  const commits = payload.commits || [];

  const parts: string[] = [
    `## GitHub Event: push`,
    ``,
    `**Ref**: ${ref}`,
    `**Pusher**: ${payload.pusher?.name || "unknown"}`,
    `**Repo**: ${repo.full_name}`,
    `**Compare**: ${payload.compare}`,
    ``,
    `## Commits (${commits.length})`,
  ];

  for (const commit of commits.slice(0, 10)) {
    parts.push(
      `- ${commit.id.slice(0, 7)}: ${commit.message.split("\n")[0]} (${commit.author?.username || commit.author?.name})`,
    );
  }
  if (commits.length > 10) {
    parts.push(`- ... and ${commits.length - 10} more`);
  }

  return parts.join("\n");
}

// ── Haiku System Prompt ─────────────────────────────────────────────────────

const HAIKU_SYSTEM_PROMPT = `You are Aura's GitHub event handler. You receive GitHub events with rich context and decide what action to take.

You have tools to:
- Post to Slack channels, threads, or DMs
- Read and update your tracking notes
- Dispatch Cursor agents for code fixes

Rules:
- Be concise in all Slack messages. No walls of text.
- Only act on PRs/issues that belong to us (created by ${GITHUB_BOT_USER} or tracked Cursor agents)
- For PR review comments: understand what's being asked, then either dispatch a Cursor agent to fix the code or reply on the PR explaining your reasoning
- For CI failures: read the logs, diagnose the root cause, and either dispatch a Cursor agent to fix it or notify the requester with a diagnosis
- For merged PRs: notify the originating Slack thread that the PR was merged
- For new PRs (opened): notify the requester with a summary
- For pushes to main: just note it, only notify if it's relevant to something being tracked
- Don't spam. If an event doesn't need action, do nothing and just say "No action needed."
- Cap yourself at 10 steps. If you can't resolve something in 10 steps, summarize what you found and notify the requester.
- When posting to Slack, use mrkdwn formatting (not markdown). Use *bold*, _italic_, \`code\`, and <url|text> for links.`;

// ── Event Filtering ─────────────────────────────────────────────────────────

function shouldHandleEvent(
  eventType: string,
  payload: any,
): boolean {
  switch (eventType) {
    case "pull_request":
      return HANDLED_PR_ACTIONS.has(payload.action);

    case "pull_request_review_comment":
      return (
        payload.action === "created" &&
        payload.comment?.user?.login !== GITHUB_BOT_USER
      );

    case "check_run":
      return (
        payload.action === "completed" &&
        HANDLED_CHECK_CONCLUSIONS.has(payload.check_run?.conclusion)
      );

    case "issue_comment":
      return (
        payload.action === "created" &&
        payload.comment?.user?.login !== GITHUB_BOT_USER
      );

    case "push":
      return payload.ref === "refs/heads/main";

    default:
      return false;
  }
}

// ── Context Dispatcher ──────────────────────────────────────────────────────

async function gatherContext(
  eventType: string,
  payload: any,
): Promise<string> {
  switch (eventType) {
    case "pull_request":
      return gatherPRContext(payload);
    case "pull_request_review_comment":
      return gatherPRReviewCommentContext(payload);
    case "check_run":
      return gatherCheckRunContext(payload);
    case "issue_comment":
      return gatherIssueCommentContext(payload);
    case "push":
      return gatherPushContext(payload);
    default:
      return `## Unknown event: ${eventType}\n\n${JSON.stringify(payload).slice(0, 5000)}`;
  }
}

// ── Haiku Actor ─────────────────────────────────────────────────────────────

async function runHaikuActor(
  eventType: string,
  context: string,
): Promise<void> {
  const model = await getFastModel();

  const adminIds = (process.env.AURA_ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  // Build restricted tool set — only expose what the system prompt describes
  // (Slack messaging, notes, Cursor agents). GitHub webhook payloads contain
  // user-controlled content (PR descriptions, review comments, issue bodies)
  // so we minimize the prompt injection surface by excluding sandbox execution,
  // email, browser automation, BigQuery, Sheets, and other sensitive tools.
  const allSlackTools = createSlackTools(slackClient, {
    userId: adminIds[0] || "aura",
  });

  const tools = {
    send_channel_message: allSlackTools.send_channel_message,
    send_thread_reply: allSlackTools.send_thread_reply,
    send_direct_message: allSlackTools.send_direct_message,
    save_note: allSlackTools.save_note,
    read_note: allSlackTools.read_note,
    list_notes: allSlackTools.list_notes,
    edit_note: allSlackTools.edit_note,
    search_notes: allSlackTools.search_notes,
    delete_note: allSlackTools.delete_note,
    dispatch_cursor_agent: allSlackTools.dispatch_cursor_agent,
    check_cursor_agent: allSlackTools.check_cursor_agent,
    followup_cursor_agent: allSlackTools.followup_cursor_agent,
    list_cursor_agents: allSlackTools.list_cursor_agents,

    post_github_comment: tool({
      description:
        "Post a comment on a GitHub PR or issue. Use this to reply to review comments or provide CI failure analysis on the PR itself.",
      inputSchema: z.object({
        owner: z.string().describe("Repository owner, e.g. 'realadvisor'"),
        repo: z.string().describe("Repository name, e.g. 'aura'"),
        issue_number: z.number().describe("PR or issue number"),
        body: z.string().describe("Comment body (GitHub markdown)"),
      }),
      execute: async ({ owner, repo, issue_number, body }) => {
        try {
          const token = await getCredential("github_token");
          if (!token) return { ok: false, error: "GitHub token not configured" };

          const res = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/issues/${issue_number}/comments`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github.v3+json",
                "Content-Type": "application/json",
                "User-Agent": "aura-webhook",
              },
              body: JSON.stringify({ body }),
            },
          );

          if (!res.ok) {
            const text = await res.text();
            return { ok: false, error: `GitHub API error ${res.status}: ${text}` };
          }

          const data = (await res.json()) as any;
          logger.info("post_github_comment: posted", {
            owner,
            repo,
            issue_number,
            commentId: data.id,
          });
          return { ok: true, comment_url: data.html_url };
        } catch (error: any) {
          return { ok: false, error: `Failed to post comment: ${error.message}` };
        }
      },
    }),

    post_github_review_reply: tool({
      description:
        "Reply to a specific PR review comment thread. Use this to respond inline to review feedback on a specific line of code.",
      inputSchema: z.object({
        owner: z.string().describe("Repository owner"),
        repo: z.string().describe("Repository name"),
        pull_number: z.number().describe("PR number"),
        comment_id: z.number().describe("The review comment ID to reply to"),
        body: z.string().describe("Reply body (GitHub markdown)"),
      }),
      execute: async ({ owner, repo, pull_number, comment_id, body }) => {
        try {
          const token = await getCredential("github_token");
          if (!token) return { ok: false, error: "GitHub token not configured" };

          const res = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${pull_number}/comments/${comment_id}/replies`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github.v3+json",
                "Content-Type": "application/json",
                "User-Agent": "aura-webhook",
              },
              body: JSON.stringify({ body }),
            },
          );

          if (!res.ok) {
            const text = await res.text();
            return { ok: false, error: `GitHub API error ${res.status}: ${text}` };
          }

          const data = (await res.json()) as any;
          logger.info("post_github_review_reply: posted", {
            owner,
            repo,
            pull_number,
            comment_id,
            replyId: data.id,
          });
          return { ok: true, comment_url: data.html_url };
        } catch (error: any) {
          return { ok: false, error: `Failed to reply: ${error.message}` };
        }
      },
    }),

    trigger_vercel_deploy: tool({
      description:
        "Trigger a Vercel production deployment via deploy hook. Use after merging PRs or when a redeploy is needed.",
      inputSchema: z.object({
        reason: z.string().describe("Short reason for the deploy"),
      }),
      execute: async ({ reason }) => {
        try {
          const hookUrl = process.env.VERCEL_DEPLOY_HOOK;
          if (!hookUrl) return { ok: false, error: "VERCEL_DEPLOY_HOOK not configured" };

          const res = await fetch(hookUrl, { method: "POST" });
          if (!res.ok) {
            return { ok: false, error: `Deploy hook returned ${res.status}` };
          }

          logger.info("trigger_vercel_deploy: triggered", { reason });
          return { ok: true, message: `Deploy triggered: ${reason}` };
        } catch (error: any) {
          return { ok: false, error: `Failed to trigger deploy: ${error.message}` };
        }
      },
    }),
  };

  try {
    const result = await generateText({
      model,
      system: HAIKU_SYSTEM_PROMPT,
      prompt: context,
      tools,
      stopWhen: stepCountIs(10),
    });

    logger.info("GitHub webhook Haiku actor completed", {
      steps: result.steps.length,
      usage: {
        input: result.totalUsage.inputTokens,
        output: result.totalUsage.outputTokens,
      },
      text: result.text?.slice(0, 200),
    });
  } catch (error: any) {
    logger.error("GitHub webhook Haiku actor failed", {
      error: error.message,
    });
    throw error;
  }
}

// ── Hono Sub-App ────────────────────────────────────────────────────────────

export const githubWebhookApp = new Hono();

githubWebhookApp.post("/api/webhook/github", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") || "";
  const eventType = c.req.header("x-github-event") || "";
  const deliveryId = c.req.header("x-github-delivery") || "";

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

  if (!shouldHandleEvent(eventType, payload)) {
    logger.debug("GitHub webhook event not handled", {
      eventType,
      action: payload.action,
      deliveryId,
    });
    return c.json({ ok: true, skipped: "unhandled_event" });
  }

  if (deliveryId) {
    const claimed = await claimEvent(deliveryId, "github-webhook");
    if (!claimed) {
      logger.info("GitHub webhook duplicate delivery, skipping", { deliveryId });
      return c.json({ ok: true, skipped: "duplicate" });
    }
  }

  logger.info("GitHub webhook received", {
    eventType,
    action: payload.action,
    deliveryId,
    repo: payload.repository?.full_name,
  });

  const processWebhook = async () => {
    try {
      const context = await gatherContext(eventType, payload);
      await runHaikuActor(eventType, context);
    } catch (err) {
      recordError("github_webhook", err, { eventType, deliveryId });
    }
  };

  waitUntil(processWebhook());
  return c.json({ ok: true });
});

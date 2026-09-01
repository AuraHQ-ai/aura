import { Hono } from "hono";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { githubPullRequests } from "@aura/db/schema";
import { logger } from "../lib/logger.js";
import { recordError } from "../lib/metrics.js";

// GitHub webhook handler — phase 1 of issue #271. Deliberately tight scope:
// HMAC-validated endpoint handling `pull_request` (opened / ready_for_review /
// closed) and `issues` (closed) only. On merge, issues referenced with
// closing keywords ("Fixes #N") in the PR body are auto-closed. No
// auto-merge, no CI gating, no LLM actor.

/**
 * Verifies GitHub's `X-Hub-Signature-256` header (HMAC-SHA256 of the raw
 * body, hex-encoded, prefixed with "sha256=") against GITHUB_WEBHOOK_SECRET.
 */
export function verifyGitHubWebhookSignature(
  rawBody: string,
  signature: string,
  secret = process.env.GITHUB_WEBHOOK_SECRET,
): boolean {
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

// GitHub's closing keywords: https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
const CLOSING_KEYWORD_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

/** Extracts issue numbers referenced via closing keywords ("Fixes #N") in a PR body. */
export function parseClosingIssueReferences(body: string | null | undefined): number[] {
  if (!body) return [];
  const numbers = new Set<number>();
  for (const match of body.matchAll(CLOSING_KEYWORD_PATTERN)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers];
}

type GitHubApiOptions = {
  fetchImpl?: typeof fetch;
  githubToken?: string | null;
};

async function githubRest(
  method: "GET" | "PATCH",
  path: string,
  options: GitHubApiOptions,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.githubToken ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not configured");

  const response = await fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let json: any = null;
  try {
    json = await response.json();
  } catch {
    // Some responses have no body — status is enough for the callers here.
  }
  return { status: response.status, json };
}

/**
 * Closes `issueNumber` on `repo` if it is still open. Fail-soft per issue:
 * returns what happened instead of throwing, so one bad reference never
 * blocks the rest of a merge event.
 */
async function closeIssueIfOpen(
  repo: string,
  issueNumber: number,
  options: GitHubApiOptions,
): Promise<"closed" | "already_closed" | "not_found" | "failed"> {
  try {
    const issue = await githubRest("GET", `/repos/${repo}/issues/${issueNumber}`, options);
    if (issue.status === 404) return "not_found";
    if (issue.status !== 200) return "failed";
    if (issue.json?.state !== "open") return "already_closed";
    // Issues API also returns PRs — never try to "close" a PR reference.
    if (issue.json?.pull_request) return "not_found";

    const patch = await githubRest(
      "PATCH",
      `/repos/${repo}/issues/${issueNumber}`,
      options,
      { state: "closed", state_reason: "completed" },
    );
    return patch.status === 200 ? "closed" : "failed";
  } catch (error) {
    logger.warn("GitHub webhook: failed to close referenced issue", {
      repo,
      issueNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

function getWorkspaceId(): string {
  return process.env.DEFAULT_WORKSPACE_ID || "default";
}

type GitHubWebhookOptions = GitHubApiOptions;

export function createGitHubWebhookApp(
  database: any = db,
  options: GitHubWebhookOptions = {},
) {
  const app = new Hono();

  app.post("/", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("x-hub-signature-256") || "";
    const event = c.req.header("x-github-event") || "";
    const deliveryId = c.req.header("x-github-delivery") || "";

    if (!process.env.GITHUB_WEBHOOK_SECRET) {
      logger.warn("GITHUB_WEBHOOK_SECRET not configured — rejecting GitHub webhook");
      return c.json({ error: "Webhook not configured" }, 403);
    }

    if (!verifyGitHubWebhookSignature(rawBody, signature)) {
      logger.warn("GitHub webhook signature validation failed — rejecting", {
        event,
        deliveryId,
        hasSignature: signature.length > 0,
      });
      return c.json({ error: "Invalid signature" }, 401);
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    try {
      if (event === "pull_request") {
        return await handlePullRequestEvent(c, database, payload, options);
      }
      if (event === "issues") {
        return await handleIssuesEvent(c, database, payload);
      }
      return c.json({ ok: true, handled: false, reason: "unsupported_event" });
    } catch (error) {
      recordError("github_webhook", error, { event, deliveryId });
      return c.json({ error: "Webhook processing failed" }, 500);
    }
  });

  return app;
}

async function upsertPullRequest(
  database: any,
  pr: any,
  repo: string,
  state: "open" | "closed" | "merged",
): Promise<void> {
  const linkedIssues = parseClosingIssueReferences(pr.body);
  const now = new Date();
  const values = {
    workspaceId: getWorkspaceId(),
    repo,
    number: pr.number,
    title: pr.title ?? null,
    url: pr.html_url ?? null,
    author: pr.user?.login ?? null,
    state,
    linkedIssues,
    openedAt: pr.created_at ? new Date(pr.created_at) : null,
    mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
    closedAt: pr.closed_at ? new Date(pr.closed_at) : null,
    updatedAt: now,
  };

  await database
    .insert(githubPullRequests)
    .values(values)
    .onConflictDoUpdate({
      target: [
        githubPullRequests.workspaceId,
        githubPullRequests.repo,
        githubPullRequests.number,
      ],
      set: {
        title: values.title,
        url: values.url,
        author: values.author,
        state: values.state,
        linkedIssues: values.linkedIssues,
        mergedAt: values.mergedAt,
        closedAt: values.closedAt,
        updatedAt: now,
      },
    });
}

async function handlePullRequestEvent(
  c: any,
  database: any,
  payload: any,
  options: GitHubApiOptions,
) {
  const action: string = payload.action ?? "";
  const pr = payload.pull_request;
  const repo: string = payload.repository?.full_name ?? "";

  if (!pr || !repo || typeof pr.number !== "number") {
    return c.json({ error: "Invalid payload" }, 400);
  }

  if (action === "opened" || action === "ready_for_review") {
    await upsertPullRequest(database, pr, repo, "open");
    logger.info("GitHub webhook: recorded pull request", {
      repo,
      number: pr.number,
      action,
      linkedIssues: parseClosingIssueReferences(pr.body),
    });
    return c.json({ ok: true, handled: true, action });
  }

  if (action === "closed") {
    const merged = pr.merged === true;
    await upsertPullRequest(database, pr, repo, merged ? "merged" : "closed");

    const closedIssues: Array<{ issue: number; result: string }> = [];
    if (merged) {
      for (const issueNumber of parseClosingIssueReferences(pr.body)) {
        const result = await closeIssueIfOpen(repo, issueNumber, options);
        closedIssues.push({ issue: issueNumber, result });
      }
    }

    logger.info("GitHub webhook: pull request closed", {
      repo,
      number: pr.number,
      merged,
      closedIssues,
    });
    return c.json({ ok: true, handled: true, action, merged, closedIssues });
  }

  return c.json({ ok: true, handled: false, reason: "unsupported_action" });
}

async function handleIssuesEvent(c: any, database: any, payload: any) {
  const action: string = payload.action ?? "";
  const issue = payload.issue;
  const repo: string = payload.repository?.full_name ?? "";

  if (action !== "closed") {
    return c.json({ ok: true, handled: false, reason: "unsupported_action" });
  }
  if (!issue || !repo || typeof issue.number !== "number") {
    return c.json({ error: "Invalid payload" }, 400);
  }

  // Read-only: surface which recorded PRs reference the closed issue so the
  // issue ↔ PR mapping stays observable. Closing behaviour stays on the PR
  // merge path only.
  const linkedPrs = await database
    .select()
    .from(githubPullRequests)
    .where(
      and(
        eq(githubPullRequests.workspaceId, getWorkspaceId()),
        eq(githubPullRequests.repo, repo),
      ),
    );
  const referencing = (linkedPrs as Array<{ number: number; linkedIssues: number[] }>)
    .filter((row) => row.linkedIssues?.includes(issue.number))
    .map((row) => row.number);

  logger.info("GitHub webhook: issue closed", {
    repo,
    issue: issue.number,
    referencingPrs: referencing,
  });
  return c.json({ ok: true, handled: true, action, referencingPrs: referencing });
}

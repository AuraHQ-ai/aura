import { logger } from "./logger.js";
import { resolveCredentialValue } from "./credentials.js";

const CURSOR_API_BASE = "https://api.cursor.com/v0";

async function getApiKey(): Promise<string> {
  const key = await resolveCredentialValue("cursor_api_key");
  if (!key) throw new Error("cursor_api_key credential is not configured");
  return key;
}

async function headers(): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await getApiKey()}`,
    "Content-Type": "application/json",
  };
}

export interface LaunchCursorAgentParams {
  prompt: string;
  /** Full GitHub URL, e.g. "https://github.com/owner/repo" */
  repository: string;
  ref?: string;
  branchName?: string;
  autoCreatePr?: boolean;
  webhookUrl?: string;
  /** Must be at least 32 characters if provided */
  webhookSecret?: string;
}

export interface CursorAgentResponse {
  id: string;
  status?: string;
  dashboardUrl?: string;
}

export interface CursorAgentStatus {
  id: string;
  status: string;
  target?: {
    prUrl?: string;
    branchName?: string;
  };
  summary?: string;
  createdAt?: string;
  finishedAt?: string;
}

export interface ResolveCursorAgentPrUrlParams {
  prUrl?: string;
  branchName?: string;
  repo: string;
  githubToken?: string | null;
  fetchImpl?: typeof fetch;
}

export interface GitHubPullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export type MarkPullRequestReadyResult =
  | "marked"
  | "already_ready"
  | "skipped"
  | "failed";

interface GitHubGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
  message?: string;
}

export function parseGitHubPullRequestUrl(
  prUrl: string,
): GitHubPullRequestRef | null {
  try {
    const url = new URL(prUrl);
    if (url.hostname !== "github.com") return null;

    const [owner, repo, pullSegment, numberSegment] = url.pathname
      .split("/")
      .filter(Boolean);
    if (!owner || !repo || pullSegment !== "pull" || !numberSegment) {
      return null;
    }

    const number = Number(numberSegment);
    if (!Number.isInteger(number) || number <= 0) return null;

    return { owner, repo, number };
  } catch {
    return null;
  }
}

async function githubGraphql<T>({
  githubToken,
  query,
  variables,
  fetchImpl,
}: {
  githubToken: string;
  query: string;
  variables: Record<string, unknown>;
  fetchImpl: typeof fetch;
}): Promise<T | undefined> {
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "Aura",
    },
    body: JSON.stringify({ query, variables }),
  });

  let body: GitHubGraphqlResponse<T> | undefined;
  try {
    body = (await response.json()) as GitHubGraphqlResponse<T>;
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    throw new Error(
      `GitHub GraphQL request failed (${response.status}): ${
        body?.message || "unknown error"
      }`,
    );
  }

  if (body?.errors?.length) {
    throw new Error(
      `GitHub GraphQL error: ${body.errors
        .map((error) => error.message || "unknown error")
        .join("; ")}`,
    );
  }

  return body?.data;
}

export async function markPullRequestReadyForReview({
  prUrl,
  githubToken,
  fetchImpl = fetch,
}: {
  prUrl: string;
  githubToken: string | null | undefined;
  fetchImpl?: typeof fetch;
}): Promise<MarkPullRequestReadyResult> {
  if (!githubToken) return "skipped";

  const pr = parseGitHubPullRequestUrl(prUrl);
  if (!pr) return "skipped";

  try {
    const data = await githubGraphql<{
      repository: {
        pullRequest: { id: string; isDraft: boolean; number: number } | null;
      } | null;
    }>({
      githubToken,
      fetchImpl,
      query: `
        query CursorWebhookPullRequest($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              id
              isDraft
              number
            }
          }
        }
      `,
      variables: {
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
      },
    });

    const pullRequest = data?.repository?.pullRequest;
    if (!pullRequest) {
      throw new Error(`GitHub PR #${pr.number} not found`);
    }

    if (!pullRequest.isDraft) {
      logger.info("Cursor agent webhook: PR already ready for review", {
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
      });
      return "already_ready";
    }

    await githubGraphql<{
      markPullRequestReadyForReview: {
        pullRequest: { id: string; isDraft: boolean; number: number } | null;
      } | null;
    }>({
      githubToken,
      fetchImpl,
      query: `
        mutation CursorWebhookMarkPullRequestReady($pullRequestId: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
            pullRequest {
              id
              isDraft
              number
            }
          }
        }
      `,
      variables: { pullRequestId: pullRequest.id },
    });

    logger.info(
      `Cursor agent webhook: marked PR #${pr.number} ready for review`,
      {
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
      },
    );
    return "marked";
  } catch (error) {
    logger.warn("Cursor agent webhook: failed to mark PR ready for review", {
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

export async function resolveCursorAgentPrUrl({
  prUrl,
  branchName,
  repo,
  githubToken,
  fetchImpl = fetch,
}: ResolveCursorAgentPrUrlParams): Promise<string> {
  if (prUrl) return prUrl;
  if (!branchName) return "";

  try {
    const owner = repo.split("/")[0];
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
    };
    if (githubToken) headers.Authorization = `token ${githubToken}`;

    const lookupUrl = new URL(`https://api.github.com/repos/${repo}/pulls`);
    lookupUrl.searchParams.set("head", `${owner}:${branchName}`);
    lookupUrl.searchParams.set("state", "open");

    const ghRes = await fetchImpl(lookupUrl.toString(), { headers });
    if (!ghRes.ok) return "";

    const pulls = (await ghRes.json()) as unknown;
    if (Array.isArray(pulls)) {
      const firstPrUrl = pulls[0]?.html_url;
      if (typeof firstPrUrl === "string" && firstPrUrl) {
        return firstPrUrl;
      }
    }

    return `https://github.com/${repo}/tree/${branchName}`;
  } catch {
    return "";
  }
}

export async function launchCursorAgent(
  params: LaunchCursorAgentParams,
): Promise<CursorAgentResponse> {
  const body: Record<string, unknown> = {
    prompt: { text: params.prompt },
    source: {
      repository: params.repository,
      ...(params.ref && { ref: params.ref }),
    },
  };

  const target: Record<string, unknown> = {};
  if (params.branchName) target.branchName = params.branchName;
  if (params.autoCreatePr !== undefined)
    target.autoCreatePr = params.autoCreatePr;
  if (Object.keys(target).length > 0) body.target = target;

  if (params.webhookUrl) {
    const webhook: Record<string, string> = { url: params.webhookUrl };
    if (params.webhookSecret) webhook.secret = params.webhookSecret;
    body.webhook = webhook;
  }

  logger.info("launchCursorAgent: dispatching", {
    repository: params.repository,
    branch: params.branchName,
  });

  const res = await fetch(`${CURSOR_API_BASE}/agents`, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cursor API POST /agents failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as CursorAgentResponse;
  logger.info("launchCursorAgent: launched", { id: data.id });
  return data;
}

export async function getCursorAgentStatus(
  agentId: string,
): Promise<CursorAgentStatus> {
  const res = await fetch(`${CURSOR_API_BASE}/agents/${agentId}`, {
    method: "GET",
    headers: await headers(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Cursor API GET /agents/${agentId} failed (${res.status}): ${text}`,
    );
  }

  return (await res.json()) as CursorAgentStatus;
}

export async function followupCursorAgent(
  agentId: string,
  prompt: string,
): Promise<CursorAgentResponse> {
  const res = await fetch(`${CURSOR_API_BASE}/agents/${agentId}/followup`, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify({ prompt: { text: prompt } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Cursor API POST /agents/${agentId}/followup failed (${res.status}): ${text}`,
    );
  }
  return (await res.json()) as CursorAgentResponse;
}

export async function getCursorConversation(agentId: string): Promise<any> {
  const res = await fetch(
    `${CURSOR_API_BASE}/agents/${agentId}/conversation`,
    {
      method: "GET",
      headers: await headers(),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Cursor API GET /agents/${agentId}/conversation failed (${res.status}): ${text}`,
    );
  }
  return await res.json();
}

export async function stopCursorAgent(agentId: string): Promise<any> {
  const res = await fetch(`${CURSOR_API_BASE}/agents/${agentId}/stop`, {
    method: "POST",
    headers: await headers(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Cursor API POST /agents/${agentId}/stop failed (${res.status}): ${text}`,
    );
  }
  return await res.json();
}

export async function listCursorAgents(prUrl?: string): Promise<any> {
  const url = new URL(`${CURSOR_API_BASE}/agents`);
  if (prUrl) url.searchParams.set("prUrl", prUrl);
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: await headers(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cursor API GET /agents failed (${res.status}): ${text}`);
  }
  return await res.json();
}


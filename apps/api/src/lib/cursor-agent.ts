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


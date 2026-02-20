import { logger } from "./logger.js";

const CURSOR_API_BASE = "https://api.cursor.com/v0";

function getApiKey(): string {
  const key = process.env.CURSOR_API_KEY;
  if (!key) throw new Error("CURSOR_API_KEY is not configured");
  return key;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getApiKey()}`,
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
    headers: headers(),
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
    headers: headers(),
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
  const res = await fetch(`${CURSOR_API_BASE}/agents/${agentId}/follow-up`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ prompt: { text: prompt } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Cursor API POST /agents/${agentId}/follow-up failed (${res.status}): ${text}`,
    );
  }
  return (await res.json()) as CursorAgentResponse;
}

export async function getCursorConversation(agentId: string): Promise<any> {
  const res = await fetch(
    `${CURSOR_API_BASE}/agents/${agentId}/conversation`,
    {
      method: "GET",
      headers: headers(),
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
    headers: headers(),
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
    headers: headers(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cursor API GET /agents failed (${res.status}): ${text}`);
  }
  return await res.json();
}


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
  repo: string;
  ref?: string;
  branchName?: string;
  autoCreatePr?: boolean;
  webhookUrl?: string;
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

export interface CursorAgentConversation {
  id: string;
  messages: Array<{
    role: string;
    content: string;
  }>;
}

export async function launchCursorAgent(
  params: LaunchCursorAgentParams,
): Promise<CursorAgentResponse> {
  const body: Record<string, unknown> = {
    prompt: params.prompt,
    repo: params.repo,
  };
  if (params.ref) body.ref = params.ref;
  if (params.branchName) body.branchName = params.branchName;
  if (params.autoCreatePr !== undefined)
    body.autoCreatePr = params.autoCreatePr;
  if (params.webhookUrl) body.webhookUrl = params.webhookUrl;
  if (params.webhookSecret) body.webhookSecret = params.webhookSecret;

  logger.info("launchCursorAgent: dispatching", {
    repo: params.repo,
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

export async function getCursorAgentConversation(
  agentId: string,
): Promise<CursorAgentConversation> {
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

  return (await res.json()) as CursorAgentConversation;
}

export async function sendCursorAgentFollowup(
  agentId: string,
  text: string,
): Promise<void> {
  const res = await fetch(`${CURSOR_API_BASE}/agents/${agentId}/followup`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Cursor API POST /agents/${agentId}/followup failed (${res.status}): ${body}`,
    );
  }
}

export async function stopCursorAgent(agentId: string): Promise<void> {
  const res = await fetch(`${CURSOR_API_BASE}/agents/${agentId}/stop`, {
    method: "POST",
    headers: headers(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Cursor API POST /agents/${agentId}/stop failed (${res.status}): ${body}`,
    );
  }
}

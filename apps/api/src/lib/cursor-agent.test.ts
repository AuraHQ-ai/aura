import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

const resolveCredentialValueMock = vi.hoisted(() =>
  vi.fn(async () => "cursor-api-key"),
);

vi.mock("./credentials.js", () => ({
  resolveCredentialValue: resolveCredentialValueMock,
}));

const { launchCursorAgent, resolveCursorAgentPrUrl } = await import(
  "./cursor-agent.js"
);

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    json: vi.fn(async () => data),
  } as unknown as Response;
}

function textResponse(data: unknown): Response {
  return {
    ok: true,
    json: vi.fn(async () => data),
    text: vi.fn(async () => JSON.stringify(data)),
  } as unknown as Response;
}

function getFetchRequestBody(
  fetchMock: ReturnType<typeof vi.fn>,
): Record<string, unknown> {
  const call = fetchMock.mock.calls[0] as [unknown, RequestInit] | undefined;
  expect(call).toBeDefined();
  return JSON.parse(call![1].body as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resolveCredentialValueMock.mockClear();
});

describe("resolveCursorAgentPrUrl", () => {
  it("passes through the payload PR URL when present", async () => {
    const fetchMock = vi.fn();

    const result = await resolveCursorAgentPrUrl({
      prUrl: "https://github.com/AuraHQ-ai/aura/pull/123",
      branchName: "cursor/fix-issue-1019",
      repo: "AuraHQ-ai/aura",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe("https://github.com/AuraHQ-ai/aura/pull/123");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks up the open PR from the branch when the payload PR URL is absent", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const requestUrl = new URL(url);
      expect(requestUrl.pathname).toBe("/repos/AuraHQ-ai/aura/pulls");
      expect(requestUrl.searchParams.get("head")).toBe(
        "AuraHQ-ai:cursor/fix-issue-1019",
      );
      expect(requestUrl.searchParams.get("state")).toBe("open");
      expect(init?.headers).toMatchObject({ Authorization: "token gh-token" });
      return jsonResponse([
        { html_url: "https://github.com/AuraHQ-ai/aura/pull/456" },
      ]);
    });

    const result = await resolveCursorAgentPrUrl({
      branchName: "cursor/fix-issue-1019",
      repo: "AuraHQ-ai/aura",
      githubToken: "gh-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe("https://github.com/AuraHQ-ai/aura/pull/456");
  });

  it("falls back to the branch tree when no open PR matches the branch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));

    const result = await resolveCursorAgentPrUrl({
      branchName: "cursor/fix-issue-1019",
      repo: "AuraHQ-ai/aura",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe(
      "https://github.com/AuraHQ-ai/aura/tree/cursor/fix-issue-1019",
    );
  });

  it("falls back gracefully when GitHub PR lookup throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("github down");
    });

    const result = await resolveCursorAgentPrUrl({
      branchName: "cursor/fix-issue-1019",
      repo: "AuraHQ-ai/aura",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe("");
  });
});

describe("launchCursorAgent", () => {
  it("sends model in the request body when provided", async () => {
    const fetchMock = vi.fn(async () => textResponse({ id: "agent-123" }));
    vi.stubGlobal("fetch", fetchMock);

    await launchCursorAgent({
      prompt: "Fix the issue",
      repository: "https://github.com/AuraHQ-ai/aura",
      model: " claude-sonnet-4.5 ",
    });

    const body = getFetchRequestBody(fetchMock);
    expect(body.model).toBe("claude-sonnet-4.5");
  });

  it("omits model from the request body when absent", async () => {
    const fetchMock = vi.fn(async () => textResponse({ id: "agent-123" }));
    vi.stubGlobal("fetch", fetchMock);

    await launchCursorAgent({
      prompt: "Fix the issue",
      repository: "https://github.com/AuraHQ-ai/aura",
    });

    const body = getFetchRequestBody(fetchMock);
    expect(body).not.toHaveProperty("model");
  });

  it("omits model from the request body when empty", async () => {
    const fetchMock = vi.fn(async () => textResponse({ id: "agent-123" }));
    vi.stubGlobal("fetch", fetchMock);

    await launchCursorAgent({
      prompt: "Fix the issue",
      repository: "https://github.com/AuraHQ-ai/aura",
      model: "   ",
    });

    const body = getFetchRequestBody(fetchMock);
    expect(body).not.toHaveProperty("model");
  });
});

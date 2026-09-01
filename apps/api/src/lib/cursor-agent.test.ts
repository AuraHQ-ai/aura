import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./credentials.js", () => ({
  resolveCredentialValue: vi.fn(async () => "cursor-api-key"),
}));

const {
  launchCursorAgent,
  markPullRequestReadyForReview,
  parseGitHubPullRequestUrl,
  resolveCursorAgentPrUrl,
} = await import("./cursor-agent.js");
const { logger } = await import("./logger.js");

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn(async () => data),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("launchCursorAgent model param", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function launchFetchMock() {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "agent-1", status: "CREATING" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const baseParams = {
    prompt: "do the thing",
    repository: "https://github.com/AuraHQ-ai/aura",
    ref: "main",
    branchName: "cursor/do-the-thing",
  };

  it("sends model in the request body when provided", async () => {
    const fetchMock = launchFetchMock();

    await launchCursorAgent({ ...baseParams, model: "claude-sonnet-4.5" });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe("claude-sonnet-4.5");
  });

  it("omits model from the request body when not provided", async () => {
    const fetchMock = launchFetchMock();

    await launchCursorAgent(baseParams);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).not.toHaveProperty("model");
  });

  it("treats an empty/whitespace model as omitted", async () => {
    const fetchMock = launchFetchMock();

    await launchCursorAgent({ ...baseParams, model: "  " });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).not.toHaveProperty("model");
  });

  it("trims the model value before sending it", async () => {
    const fetchMock = launchFetchMock();

    await launchCursorAgent({ ...baseParams, model: " gpt-5 " });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe("gpt-5");
  });
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

describe("parseGitHubPullRequestUrl", () => {
  it("parses owner, repo, and number from a GitHub PR URL", () => {
    expect(
      parseGitHubPullRequestUrl("https://github.com/AuraHQ-ai/aura/pull/1037"),
    ).toEqual({
      owner: "AuraHQ-ai",
      repo: "aura",
      number: 1037,
    });
  });

  it("returns null for non-PR URLs", () => {
    expect(
      parseGitHubPullRequestUrl(
        "https://github.com/AuraHQ-ai/aura/tree/feature-branch",
      ),
    ).toBeNull();
  });
});

describe("markPullRequestReadyForReview", () => {
  it("marks a draft PR ready for review", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));

      if (String(body.query).includes("repository(owner:")) {
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                id: "PR_kwDOExample",
                isDraft: true,
                number: 1037,
              },
            },
          },
        });
      }

      if (String(body.query).includes("markPullRequestReadyForReview")) {
        expect(body.variables).toEqual({ pullRequestId: "PR_kwDOExample" });
        return jsonResponse({
          data: {
            markPullRequestReadyForReview: {
              pullRequest: {
                id: "PR_kwDOExample",
                isDraft: false,
                number: 1037,
              },
            },
          },
        });
      }

      throw new Error("unexpected GraphQL query");
    });

    const result = await markPullRequestReadyForReview({
      prUrl: "https://github.com/AuraHQ-ai/aura/pull/1037",
      githubToken: "gh-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe("marked");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      "Cursor agent webhook: marked PR #1037 ready for review",
      {
        owner: "AuraHQ-ai",
        repo: "aura",
        number: 1037,
      },
    );
  });

  it("no-ops when the PR is already ready for review", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              id: "PR_kwDOExample",
              isDraft: false,
              number: 1037,
            },
          },
        },
      }),
    );

    const result = await markPullRequestReadyForReview({
      prUrl: "https://github.com/AuraHQ-ai/aura/pull/1037",
      githubToken: "gh-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe("already_ready");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "Cursor agent webhook: PR already ready for review",
      {
        owner: "AuraHQ-ai",
        repo: "aura",
        number: 1037,
      },
    );
  });

  it("logs a warning and resolves when GitHub fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("github down");
    });

    const result = await markPullRequestReadyForReview({
      prUrl: "https://github.com/AuraHQ-ai/aura/pull/1037",
      githubToken: "gh-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe("failed");
    expect(logger.warn).toHaveBeenCalledWith(
      "Cursor agent webhook: failed to mark PR ready for review",
      {
        owner: "AuraHQ-ai",
        repo: "aura",
        number: 1037,
        error: "github down",
      },
    );
  });
});

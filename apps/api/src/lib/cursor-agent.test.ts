import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./credentials.js", () => ({
  resolveCredentialValue: vi.fn(async (name: string) =>
    name === "cursor_api_key" ? "cursor-key" : null,
  ),
}));

const {
  ensurePullRequestFixesIssue,
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
    text: vi.fn(async () => JSON.stringify(data)),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("launchCursorAgent", () => {
  async function captureLaunchBody(params: {
    model?: string;
  } = {}): Promise<Record<string, unknown>> {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({ id: "agent_123", status: "running" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await launchCursorAgent({
      prompt: "Fix the bug",
      repository: "https://github.com/AuraHQ-ai/aura",
      ...params,
    });

    expect(capturedBody).toBeDefined();
    return capturedBody!;
  }

  it("sends model in the request body when provided", async () => {
    const body = await captureLaunchBody({ model: "claude-sonnet-4.5" });

    expect(body.model).toBe("claude-sonnet-4.5");
  });

  it("omits model when no model is provided", async () => {
    const body = await captureLaunchBody();

    expect(body).not.toHaveProperty("model");
  });

  it("omits model when the model is an empty string", async () => {
    const body = await captureLaunchBody({ model: "" });

    expect(body).not.toHaveProperty("model");
  });

  it("omits model when the model is auto", async () => {
    const body = await captureLaunchBody({ model: "auto" });

    expect(body).not.toHaveProperty("model");
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

describe("ensurePullRequestFixesIssue", () => {
  it("patches the PR body when the Fixes line is missing", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        expect(body.body).toBe("Fixes #1031\n\nImplementation notes");
        return jsonResponse({ body: body.body });
      }

      return jsonResponse({ body: "Implementation notes" });
    });

    const result = await ensurePullRequestFixesIssue({
      prUrl: "https://github.com/AuraHQ-ai/aura/pull/1040",
      issueNumber: 1031,
      githubToken: "gh-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe("patched");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      "Cursor agent webhook: patched missing PR Fixes line",
      {
        owner: "AuraHQ-ai",
        repo: "aura",
        number: 1040,
        issueNumber: 1031,
      },
    );
  });

  it("does not patch when an accepted closing line is already present", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ body: "Summary\n\nCloses #1031" }),
    );

    const result = await ensurePullRequestFixesIssue({
      prUrl: "https://github.com/AuraHQ-ai/aura/pull/1040",
      issueNumber: 1031,
      githubToken: "gh-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBe("already_present");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

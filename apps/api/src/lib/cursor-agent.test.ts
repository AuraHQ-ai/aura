import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

const { resolveCursorAgentPrUrl } = await import("./cursor-agent.js");

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    json: vi.fn(async () => data),
  } as unknown as Response;
}

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

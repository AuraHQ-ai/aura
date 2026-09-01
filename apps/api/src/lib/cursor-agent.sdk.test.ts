import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

const mocks = vi.hoisted(() => ({
  agentGet: vi.fn(),
  agentList: vi.fn(),
  agentListRuns: vi.fn(),
  agentResume: vi.fn(),
  resolveCredentialValue: vi.fn(async () => "cursor-test-key"),
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./credentials.js", () => ({
  resolveCredentialValue: mocks.resolveCredentialValue,
}));

vi.mock("@cursor/sdk", () => ({
  Agent: {
    get: mocks.agentGet,
    list: mocks.agentList,
    listRuns: mocks.agentListRuns,
    resume: mocks.agentResume,
  },
}));

const {
  followupCursorAgent,
  getCursorAgentStatus,
  launchCursorAgent,
  listCursorAgents,
  resolveCursorModel,
  stopCursorAgent,
} = await import("./cursor-agent.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveCredentialValue.mockResolvedValue("cursor-test-key");
  delete process.env.CURSOR_DEFAULT_MODEL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CURSOR_DEFAULT_MODEL;
});

describe("resolveCursorModel", () => {
  it("returns a trimmed explicit model", () => {
    expect(resolveCursorModel(" claude-sonnet-4.5 ")).toBe(
      "claude-sonnet-4.5",
    );
  });

  it("falls back to CURSOR_DEFAULT_MODEL", () => {
    process.env.CURSOR_DEFAULT_MODEL = "gpt-5";
    expect(resolveCursorModel()).toBe("gpt-5");
    expect(resolveCursorModel("")).toBe("gpt-5");
  });

  it("never resolves empty or 'auto' (the API rejects both)", () => {
    expect(resolveCursorModel()).toBeUndefined();
    expect(resolveCursorModel("")).toBeUndefined();
    expect(resolveCursorModel("auto")).toBeUndefined();
    expect(resolveCursorModel("Auto")).toBeUndefined();
    process.env.CURSOR_DEFAULT_MODEL = "auto";
    expect(resolveCursorModel()).toBeUndefined();
  });
});

describe("launchCursorAgent (raw fetch — SDK lacks webhook/branchName)", () => {
  function stubLaunchFetch() {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "bc-new-agent", status: "CREATING" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("includes the model in the request body when provided", async () => {
    const fetchMock = stubLaunchFetch();

    await launchCursorAgent({
      prompt: "do the thing",
      repository: "https://github.com/AuraHQ-ai/aura",
      branchName: "cursor/do-the-thing-abc123",
      autoCreatePr: true,
      model: "claude-sonnet-4.5",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.cursor.com/v0/agents");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("claude-sonnet-4.5");
    expect(body.target).toEqual({
      branchName: "cursor/do-the-thing-abc123",
      autoCreatePr: true,
    });
  });

  it("omits the model field for empty/'auto' so Cursor auto-selects", async () => {
    const fetchMock = stubLaunchFetch();

    await launchCursorAgent({
      prompt: "do the thing",
      repository: "https://github.com/AuraHQ-ai/aura",
      model: "auto",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(init.body));
    expect(body).not.toHaveProperty("model");
  });
});

describe("getCursorAgentStatus (SDK)", () => {
  it("composes agent info + latest run status/git into the v0 status shape", async () => {
    // The backend doesn't populate SDKAgentInfo.status today — the live
    // status comes from the latest run.
    mocks.agentGet.mockResolvedValue({
      agentId: "bc-agent-1",
      name: "Fix bug",
      summary: "Fixed the bug",
      createdAt: Date.UTC(2026, 8, 1, 12, 0, 0),
      lastModified: Date.UTC(2026, 8, 1, 13, 0, 0),
    });
    mocks.agentListRuns.mockResolvedValue({
      items: [
        {
          id: "run-1",
          status: "finished",
          git: {
            branches: [
              {
                repoUrl: "https://github.com/AuraHQ-ai/aura",
                branch: "cursor/fix-bug-abc123",
                prUrl: "https://github.com/AuraHQ-ai/aura/pull/99",
              },
            ],
          },
        },
      ],
    });

    const status = await getCursorAgentStatus("bc-agent-1");

    expect(mocks.agentGet).toHaveBeenCalledWith("bc-agent-1", {
      apiKey: "cursor-test-key",
    });
    expect(status).toEqual({
      id: "bc-agent-1",
      status: "FINISHED",
      target: {
        prUrl: "https://github.com/AuraHQ-ai/aura/pull/99",
        branchName: "cursor/fix-bug-abc123",
      },
      summary: "Fixed the bug",
      createdAt: "2026-09-01T12:00:00.000Z",
      finishedAt: undefined,
    });
  });

  it("prefers the agent-level status when the backend provides one", async () => {
    mocks.agentGet.mockResolvedValue({
      agentId: "bc-agent-3",
      name: "Done",
      summary: "",
      status: "error",
    });
    mocks.agentListRuns.mockResolvedValue({
      items: [{ id: "run-1", status: "running" }],
    });

    const status = await getCursorAgentStatus("bc-agent-3");

    expect(status.status).toBe("ERROR");
  });

  it("degrades to UNKNOWN when run metadata is unavailable", async () => {
    mocks.agentGet.mockResolvedValue({
      agentId: "bc-agent-2",
      name: "WIP",
      summary: "",
    });
    mocks.agentListRuns.mockRejectedValue(new Error("runs endpoint down"));

    const status = await getCursorAgentStatus("bc-agent-2");

    expect(status.status).toBe("UNKNOWN");
    expect(status.target).toBeUndefined();
  });
});

describe("followupCursorAgent (SDK)", () => {
  it("resumes the agent, sends the prompt, and disposes the handle", async () => {
    const send = vi.fn(async () => ({ id: "run-2", status: "running" }));
    const close = vi.fn();
    mocks.agentResume.mockResolvedValue({ agentId: "bc-agent-1", send, close });

    const result = await followupCursorAgent("bc-agent-1", "also add tests");

    expect(mocks.agentResume).toHaveBeenCalledWith("bc-agent-1", {
      apiKey: "cursor-test-key",
    });
    expect(send).toHaveBeenCalledWith("also add tests");
    expect(close).toHaveBeenCalled();
    expect(result).toEqual({ id: "bc-agent-1", status: "RUNNING" });
  });

  it("disposes the handle even when send fails", async () => {
    const close = vi.fn();
    mocks.agentResume.mockResolvedValue({
      agentId: "bc-agent-1",
      send: vi.fn(async () => {
        throw new Error("agent busy");
      }),
      close,
    });

    await expect(
      followupCursorAgent("bc-agent-1", "more work"),
    ).rejects.toThrow("agent busy");
    expect(close).toHaveBeenCalled();
  });
});

describe("stopCursorAgent (SDK)", () => {
  it("cancels the active run when one is running", async () => {
    const cancel = vi.fn();
    mocks.agentListRuns.mockResolvedValue({
      items: [
        { id: "run-old", status: "finished", cancel: vi.fn() },
        { id: "run-live", status: "running", cancel },
      ],
    });

    const result = await stopCursorAgent("bc-agent-1");

    expect(cancel).toHaveBeenCalled();
    expect(result).toEqual({ id: "bc-agent-1", status: "CANCELLED" });
  });

  it("is idempotent when no run is active", async () => {
    mocks.agentListRuns.mockResolvedValue({
      items: [{ id: "run-old", status: "finished", cancel: vi.fn() }],
    });
    mocks.agentGet.mockResolvedValue({
      agentId: "bc-agent-1",
      status: "finished",
    });

    const result = await stopCursorAgent("bc-agent-1");

    expect(result).toEqual({ id: "bc-agent-1", status: "FINISHED" });
  });
});

describe("listCursorAgents (raw fetch — SDK list drops status/target)", () => {
  it("passes the v0 response through untouched, including per-agent status", async () => {
    const v0Response = {
      agents: [
        {
          id: "bc-agent-1",
          status: "RUNNING",
          name: "Fix bug",
          source: { repository: "https://github.com/AuraHQ-ai/aura" },
          target: { branchName: "cursor/fix-bug-abc123" },
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      nextCursor: "cursor-token",
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => v0Response,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listCursorAgents(
      "https://github.com/AuraHQ-ai/aura/pull/99",
    );

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v0/agents");
    expect(parsed.searchParams.get("prUrl")).toBe(
      "https://github.com/AuraHQ-ai/aura/pull/99",
    );
    expect(result).toEqual(v0Response);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getCredential: vi.fn(),
  insertValues: vi.fn(),
  insertOnConflictDoUpdate: vi.fn(),
  launchCursorAgent: vi.fn(),
}));

vi.mock("../lib/tool.js", () => ({
  defineTool: (config: any) => config,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../lib/settings.js", () => ({
  getConfig: mocks.getConfig,
}));

vi.mock("../lib/credentials.js", () => ({
  getCredential: mocks.getCredential,
  resolveCredentialValue: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: mocks.insertValues.mockImplementation(() => ({
        onConflictDoUpdate: mocks.insertOnConflictDoUpdate,
      })),
    })),
  },
}));

vi.mock("../lib/cursor-agent.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/cursor-agent.js")>(
    "../lib/cursor-agent.js",
  );
  return {
    ...actual,
    launchCursorAgent: mocks.launchCursorAgent,
  };
});

const { createCursorAgentTools } = await import("./cursor-agent.js");

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn(async () => data),
  } as unknown as Response;
}

function dispatchTool() {
  return createCursorAgentTools({
    userId: "U123",
    channelId: "C123",
    threadTs: "1700000000.000000",
  } as any).dispatch_cursor_agent as any;
}

describe("dispatch_cursor_agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env.CURSOR_DEFAULT_MODEL;
    mocks.getConfig.mockImplementation(async (_key: string, fallback?: string) =>
      fallback ?? "",
    );
    mocks.getCredential.mockResolvedValue("gh-token");
    mocks.insertOnConflictDoUpdate.mockResolvedValue(undefined);
    mocks.launchCursorAgent.mockResolvedValue({
      id: "agent_123",
      dashboardUrl: "https://cursor.com/agents/agent_123",
    });
  });

  it("uses CURSOR_DEFAULT_MODEL when no explicit model is provided", async () => {
    process.env.CURSOR_DEFAULT_MODEL = "gpt-5";
    const tool = dispatchTool();

    const result = await tool.execute(
      tool.inputSchema.parse({
        issue_description: "Fix a small bug",
      }),
    );

    expect(result.ok).toBe(true);
    expect(mocks.launchCursorAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5" }),
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("- **Model**: gpt-5"),
      }),
    );
  });

  it("dispatches issue prompts with the canonical pointer, verbatim body, and Fixes instruction", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.github.com/repos/AuraHQ-ai/aura/issues/1031");
      return jsonResponse({
        number: 1031,
        title: "Canonical pointer prompt",
        body: "First body line\n\nSecond body line",
        state: "open",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tool = dispatchTool();

    const result = await tool.execute(
      tool.inputSchema.parse({
        issue: 1031,
        key_files: ["apps/api/src/lib/cursor-agent.ts"],
      }),
    );

    expect(result.ok).toBe(true);
    const launchParams = mocks.launchCursorAgent.mock.calls[0][0];
    expect(launchParams.prompt).toContain(
      "Implement GitHub issue #1031 in AuraHQ-ai/aura exactly as written: Canonical pointer prompt",
    );
    expect(launchParams.prompt).toContain(
      "--- ISSUE BODY ---\nFirst body line\n\nSecond body line",
    );
    expect(launchParams.prompt).toContain(
      "When you open the PR, the PR body MUST start with the line: Fixes #1031",
    );
    expect(launchParams.prompt).toContain(
      "Key files to focus on:\n- apps/api/src/lib/cursor-agent.ts",
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("- **Issue**: #1031"),
      }),
    );
  });

  it("requires issue_description only when issue is absent", () => {
    const tool = dispatchTool();

    expect(() => tool.inputSchema.parse({})).toThrow(
      /Provide either issue or issue_description/,
    );
  });

  it("keeps the issue body primary and appends issue_description as additional notes when both are provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          number: 1031,
          title: "Primary issue",
          body: "Canonical issue body",
          state: "open",
        }),
      ),
    );
    const tool = dispatchTool();

    await tool.execute(
      tool.inputSchema.parse({
        issue: 1031,
        issue_description: "Use the existing feature branch.",
      }),
    );

    const prompt = mocks.launchCursorAgent.mock.calls[0][0].prompt as string;
    const bodyIndex = prompt.indexOf("--- ISSUE BODY ---\nCanonical issue body");
    const notesIndex = prompt.indexOf(
      "--- ADDITIONAL DISPATCH NOTES ---\nUse the existing feature branch.",
    );
    expect(bodyIndex).toBeGreaterThanOrEqual(0);
    expect(notesIndex).toBeGreaterThan(bodyIndex);
  });
});

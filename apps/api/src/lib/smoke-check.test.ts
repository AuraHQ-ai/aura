import type { WebClient } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

const mocks = vi.hoisted(() => ({
  safePostMessage: vi.fn(),
  resolveSlackDestination: vi.fn(),
  recordError: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("./cursor-agent.js", () => ({
  listCursorAgents: vi.fn(),
}));

vi.mock("./bigquery.js", () => ({
  getBigQueryClient: vi.fn(),
}));

vi.mock("./model-catalog.js", () => ({
  fetchGatewayModels: vi.fn(),
  getModelCatalogResponse: vi.fn(),
}));

vi.mock("./slack-messaging.js", () => ({
  safePostMessage: mocks.safePostMessage,
}));

vi.mock("../tools/slack.js", () => ({
  resolveSlackDestination: mocks.resolveSlackDestination,
}));

vi.mock("./metrics.js", () => ({
  recordError: mocks.recordError,
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: mocks.loggerWarn,
    error: vi.fn(),
  },
}));

const { runSmokeCheck } = await import("./smoke-check.js");

describe("runSmokeCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SMOKE_CHECK_NOTIFY_USER;
    delete process.env.SMOKE_CHECK_SUCCESS_CHANNEL;
    delete process.env.FOUNDER_USER_ID;
    delete process.env.AURA_ADMIN_USER_IDS;
    mocks.resolveSlackDestination.mockResolvedValue("DOWNER");
    mocks.safePostMessage.mockResolvedValue({ ok: true });
  });

  it("returns zero failures and uses the quiet success path when all probes pass", async () => {
    const result = await runSmokeCheck({
      slackClient: {} as WebClient,
      deploy: "abc123",
      successChannel: "COPS",
      probes: [
        { name: "Cursor API", run: vi.fn(async () => ({ ok: true, detail: "list agents 200" })) },
        { name: "Slack auth", run: vi.fn(async () => ({ ok: true, detail: "auth.test ok" })) },
      ],
    });

    expect(result).toEqual({
      deploy: "abc123",
      failures: 0,
      results: [
        { name: "Cursor API", ok: true, detail: "list agents 200" },
        { name: "Slack auth", ok: true, detail: "auth.test ok" },
      ],
    });
    expect(mocks.resolveSlackDestination).not.toHaveBeenCalled();
    expect(mocks.recordError).not.toHaveBeenCalled();
    expect(mocks.safePostMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: "COPS",
        text: expect.stringContaining(":white_check_mark: Deploy abc123 smoke check"),
      }),
    );
  });

  it("isolates probe errors, increments failures, and sends the loud failure DM", async () => {
    process.env.SMOKE_CHECK_NOTIFY_USER = "UOWNER";

    const afterFailureProbe = vi.fn(async () => ({ ok: true, detail: "still ran" }));
    const result = await runSmokeCheck({
      slackClient: {} as WebClient,
      deploy: "def456",
      probes: [
        {
          name: "Cursor API",
          run: vi.fn(async () => {
            throw new Error("Cursor API GET /agents failed (404)");
          }),
        },
        { name: "Slack auth", run: afterFailureProbe },
      ],
    });

    expect(result.failures).toBe(1);
    expect(result.results).toEqual([
      {
        name: "Cursor API",
        ok: false,
        detail: "Cursor API GET /agents failed (404)",
      },
      { name: "Slack auth", ok: true, detail: "still ran" },
    ]);
    expect(afterFailureProbe).toHaveBeenCalledTimes(1);
    expect(mocks.recordError).toHaveBeenCalledWith(
      "smoke_check",
      expect.any(Error),
      expect.objectContaining({
        deploy: "def456",
        failingProbes: ["Cursor API"],
      }),
    );
    expect(mocks.resolveSlackDestination).toHaveBeenCalledWith(expect.anything(), "UOWNER");
    expect(mocks.safePostMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: "DOWNER",
        text: expect.stringContaining(":warning: :x: Deploy def456 smoke check FAILED"),
      }),
    );
  });
});

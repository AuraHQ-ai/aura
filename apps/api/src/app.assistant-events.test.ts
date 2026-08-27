import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";
process.env.SLACK_SIGNING_SECRET = "slack-signing-secret";
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

const mocks = vi.hoisted(() => ({
  bootstrapAssistantThreadMock: vi.fn(),
  publishHomeTabMock: vi.fn(),
  recordErrorMock: vi.fn(),
  stopInvocationMock: vi.fn(),
  trySetAgentSessionStatusMock: vi.fn(),
  runPipelineMock: vi.fn(),
  waitUntilPromises: [] as Array<Promise<unknown>>,
}));

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn(function WebClient() {
    return {};
  }),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    mocks.waitUntilPromises.push(promise);
  },
}));

vi.mock("./cron/consolidate.js", async () => {
  const { Hono } = await import("hono");
  return { cronApp: new Hono() };
});

vi.mock("./cron/heartbeat.js", async () => {
  const { Hono } = await import("hono");
  return { heartbeatApp: new Hono() };
});

vi.mock("./cron/supervisor.js", async () => {
  const { Hono } = await import("hono");
  return { supervisorApp: new Hono() };
});

vi.mock("./cron/eval-responses.js", async () => {
  const { Hono } = await import("hono");
  return { evalResponsesApp: new Hono() };
});

vi.mock("./webhook/elevenlabs.js", async () => {
  const { Hono } = await import("hono");
  return { elevenlabsWebhookApp: new Hono() };
});

vi.mock("./webhook/sandbox-command.js", async () => {
  const { Hono } = await import("hono");
  return { createSandboxCommandWebhookApp: vi.fn(() => new Hono()) };
});

vi.mock("./routes/dashboard/index.js", async () => {
  const { Hono } = await import("hono");
  return { dashboardApp: new Hono() };
});

vi.mock("./pipeline/index.js", () => ({
  runPipeline: mocks.runPipelineMock,
}));

vi.mock("./lib/invocation-lock.js", () => ({
  stopInvocation: mocks.stopInvocationMock,
  getSupersedeReason: vi.fn(async () => "stopped"),
  interruptionNote: vi.fn(() => "_[stopped]_"),
  claimInvocation: vi.fn(),
  isInvocationCurrent: vi.fn(async () => true),
}));

vi.mock("./lib/slack-status.js", () => ({
  trySetAgentSessionStatus: mocks.trySetAgentSessionStatusMock,
  setAssistantThreadTitle: vi.fn(),
  setStatusUnsupportedChannels: new Set<string>(),
}));

vi.mock("./slack/home.js", () => ({
  ACTION_TO_SETTING: {},
  CREDENTIAL_ACTIONS: {},
  TOOLS_REPO_SAVE_ACTION: "tools_repo_save",
  TOOLS_REPO_SETTING_KEY: "tools_repo",
  buildAddCredentialBlocks: vi.fn(() => []),
  hasRole: vi.fn(async () => true),
  openAddCredentialModal: vi.fn(),
  openCredentialAccessModal: vi.fn(),
  openCredentialModal: vi.fn(),
  openShareCredentialModal: vi.fn(),
  openUpdateCredentialModal: vi.fn(),
  publishHomeTab: mocks.publishHomeTabMock,
}));

vi.mock("./slack/thread-bootstrap.js", () => ({
  bootstrapAssistantThread: mocks.bootstrapAssistantThreadMock,
}));

vi.mock("./lib/api-credentials.js", () => ({
  deleteApiCredential: vi.fn(),
  grantApiCredentialAccess: vi.fn(),
  hasPermission: vi.fn(async () => true),
  listApiCredentials: vi.fn(async () => []),
  storeApiCredential: vi.fn(),
}));

vi.mock("./lib/confirmation.js", () => ({
  resolveConfirmation: vi.fn(),
}));

vi.mock("./lib/tool.js", () => ({
  executionContext: {
    getStore: vi.fn(() => undefined),
    run: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  },
}));

vi.mock("./lib/settings.js", () => ({
  getConfig: vi.fn(async (_key: string, fallback?: string) => fallback ?? ""),
  setSetting: vi.fn(),
}));

vi.mock("./lib/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./tools/slack.js", () => ({
  resolveSlackDestination: vi.fn(),
}));

vi.mock("./lib/metrics.js", () => ({
  recordError: mocks.recordErrorMock,
}));

vi.mock("./lib/slack-messaging.js", () => ({
  safePostMessage: vi.fn(),
}));

vi.mock("./db/client.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        catch: vi.fn(),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
      })),
    })),
  },
}));

vi.mock("./lib/credentials.js", () => ({
  getCredential: vi.fn(),
}));

const app = (await import("./app.js")).default;

function slackHeaders(rawBody: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature =
    "v0=" +
    crypto
      .createHmac("sha256", process.env.SLACK_SIGNING_SECRET!)
      .update(`v0:${timestamp}:${rawBody}`, "utf8")
      .digest("hex");
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
    "content-type": "application/json",
  };
}

async function postSlackEvent(event: Record<string, unknown>) {
  const rawBody = JSON.stringify({
    type: "event_callback",
    team_id: "T123",
    event,
  });
  const response = await app.request("/api/slack/events", {
    method: "POST",
    headers: slackHeaders(rawBody),
    body: rawBody,
  });
  await Promise.all(mocks.waitUntilPromises);
  return response;
}

describe("agent-view thread bootstrap wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.waitUntilPromises.length = 0;
    mocks.bootstrapAssistantThreadMock.mockResolvedValue(undefined);
    mocks.publishHomeTabMock.mockResolvedValue(undefined);
  });

  it("assistant_thread_started is acked without bootstrapping (event retired under agent view)", async () => {
    const response = await postSlackEvent({
      type: "assistant_thread_started",
      assistant_thread: {
        channel_id: "D123",
        thread_ts: "1724264405.531769",
      },
    });

    expect(response.status).toBe(200);
    expect(mocks.bootstrapAssistantThreadMock).not.toHaveBeenCalled();
    expect(mocks.publishHomeTabMock).not.toHaveBeenCalled();
  });

  it("app_home_opened (messages tab) triggers the thread bootstrap; home tab still published", async () => {
    const response = await postSlackEvent({
      type: "app_home_opened",
      user: "U123",
      channel: "D123",
      tab: "messages",
    });

    expect(response.status).toBe(200);
    expect(
      mocks.bootstrapAssistantThreadMock,
    ).toHaveBeenCalledExactlyOnceWith({
      client: expect.anything(),
      channelId: "D123",
    });
    expect(mocks.publishHomeTabMock).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "U123",
    );
  });

  it("app_home_opened for other tabs does NOT bootstrap", async () => {
    const response = await postSlackEvent({
      type: "app_home_opened",
      user: "U123",
      channel: "D123",
      tab: "home",
    });

    expect(response.status).toBe(200);
    expect(mocks.bootstrapAssistantThreadMock).not.toHaveBeenCalled();
    expect(mocks.publishHomeTabMock).toHaveBeenCalledTimes(1);
  });

  it("bootstrap failures are recorded, never thrown", async () => {
    mocks.bootstrapAssistantThreadMock.mockRejectedValueOnce(
      new Error("slack down"),
    );

    const response = await postSlackEvent({
      type: "app_home_opened",
      user: "U123",
      channel: "D123",
      tab: "messages",
    });

    expect(response.status).toBe(200);
    expect(mocks.recordErrorMock).toHaveBeenCalledWith(
      "app_home_opened_bootstrap",
      expect.any(Error),
      { userId: "U123" },
    );
  });
});

describe("agent_session_stopped (Stop button)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.waitUntilPromises.length = 0;
    mocks.stopInvocationMock.mockResolvedValue(true);
    mocks.trySetAgentSessionStatusMock.mockResolvedValue(undefined);
  });

  it("stops the running invocation, clears the session status, and never hits the pipeline", async () => {
    const response = await postSlackEvent({
      type: "agent_session_stopped",
      channel: "D0AFEC7BEMP",
      thread_ts: "1787785660.512159",
      event_ts: "1787785700.000100",
      user: "U0678NQJ2",
      streaming_message_ts: ["1787785661.000200"],
    });

    expect(response.status).toBe(200);
    expect(mocks.stopInvocationMock).toHaveBeenCalledExactlyOnceWith(
      "D0AFEC7BEMP",
      "1787785660.512159",
      "1787785700.000100",
      "default",
    );
    expect(mocks.trySetAgentSessionStatusMock).toHaveBeenCalledExactlyOnceWith({
      client: expect.anything(),
      channelId: "D0AFEC7BEMP",
      threadTs: "1787785660.512159",
      status: "active",
    });
    expect(mocks.runPipelineMock).not.toHaveBeenCalled();
    expect(mocks.recordErrorMock).not.toHaveBeenCalled();
  });

  it("still clears the session status when stopping the lock fails", async () => {
    mocks.stopInvocationMock.mockRejectedValueOnce(new Error("db down"));

    const response = await postSlackEvent({
      type: "agent_session_stopped",
      channel: "D0AFEC7BEMP",
      thread_ts: "1787785660.512159",
      event_ts: "1787785700.000100",
      user: "U0678NQJ2",
    });

    expect(response.status).toBe(200);
    expect(mocks.recordErrorMock).toHaveBeenCalledWith(
      "agent_session_stopped",
      expect.any(Error),
      expect.objectContaining({ channelId: "D0AFEC7BEMP" }),
    );
    expect(mocks.trySetAgentSessionStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );
  });

  it("acks and does nothing without channel/thread_ts", async () => {
    const response = await postSlackEvent({ type: "agent_session_stopped", user: "U0678NQJ2" });
    expect(response.status).toBe(200);
    expect(mocks.stopInvocationMock).not.toHaveBeenCalled();
    expect(mocks.trySetAgentSessionStatusMock).not.toHaveBeenCalled();
    expect(mocks.runPipelineMock).not.toHaveBeenCalled();
  });
});

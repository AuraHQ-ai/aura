import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stopEvents } from "@aura/db/schema";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";
process.env.SLACK_SIGNING_SECRET = "slack-signing-secret";
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

const mocks = vi.hoisted(() => {
  const dbInsertValuesMock = vi.fn(async () => undefined);
  return {
    bootstrapAssistantThreadMock: vi.fn(),
    publishHomeTabMock: vi.fn(),
    recordErrorMock: vi.fn(),
    stopInvocationMock: vi.fn(),
    trySetAgentSessionStatusMock: vi.fn(),
    runPipelineMock: vi.fn(),
    logErrorMock: vi.fn(),
    dbInsertValuesMock,
    dbInsertMock: vi.fn(() => ({ values: dbInsertValuesMock })),
    waitUntilPromises: [] as Array<Promise<unknown>>,
  };
});

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

vi.mock("./lib/error-logger.js", () => ({
  logError: mocks.logErrorMock,
}));

vi.mock("./lib/slack-messaging.js", () => ({
  safePostMessage: vi.fn(),
}));

vi.mock("./db/client.js", () => ({
  db: {
    insert: mocks.dbInsertMock,
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

async function postSlackEvent(
  event: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  const rawBody = JSON.stringify({
    type: "event_callback",
    team_id: "T123",
    event,
  });
  const response = await app.request("/api/slack/events", {
    method: "POST",
    headers: { ...slackHeaders(rawBody), ...extraHeaders },
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
    mocks.stopInvocationMock.mockResolvedValue({
      displaced: true,
      stopId: "stop:11111111-2222-3333-4444-555555555555",
    });
    mocks.trySetAgentSessionStatusMock.mockResolvedValue(true);
    mocks.logErrorMock.mockResolvedValue(undefined);
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

  it("writes a durable receipt to error_events on the success path (issue #1355)", async () => {
    const response = await postSlackEvent({
      type: "agent_session_stopped",
      channel: "D0AFEC7BEMP",
      thread_ts: "1787785660.512159",
      event_ts: "1787785700.000100",
      user: "U0678NQJ2",
      streaming_message_ts: ["1787785661.000200"],
    });

    expect(response.status).toBe(200);
    expect(mocks.logErrorMock).toHaveBeenCalledExactlyOnceWith({
      errorName: "AgentSessionStopped",
      errorMessage: "agent_session_stopped receipt (displaced=true)",
      errorCode: "agent_session_stopped_receipt",
      channelId: "D0AFEC7BEMP",
      userId: "U0678NQJ2",
      context: {
        threadTs: "1787785660.512159",
        eventTs: "1787785700.000100",
        streamingMessageTs: ["1787785661.000200"],
        displaced: true,
        statusCleared: true,
        stopFailed: false,
      },
    });
  });

  it("writes exactly one stop receipt with the stop's channel/thread/user/displaced/stopId", async () => {
    const response = await postSlackEvent({
      type: "agent_session_stopped",
      channel: "D0AFEC7BEMP",
      thread_ts: "1787785660.512159",
      event_ts: "1787785700.000100",
      user: "U0678NQJ2",
      streaming_message_ts: ["1787785661.000200"],
    });

    expect(response.status).toBe(200);
    expect(mocks.dbInsertMock).toHaveBeenCalledExactlyOnceWith(stopEvents);
    expect(mocks.dbInsertValuesMock).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      channelId: "D0AFEC7BEMP",
      threadTs: "1787785660.512159",
      userId: "U0678NQJ2",
      eventTs: "1787785700.000100",
      streamingMessageTs: "1787785661.000200",
      displaced: true,
      stopId: "stop:11111111-2222-3333-4444-555555555555",
    });
    expect(mocks.recordErrorMock).not.toHaveBeenCalled();
  });

  it("writes a receipt with displaced=false when no live invocation was displaced", async () => {
    mocks.stopInvocationMock.mockResolvedValueOnce({
      displaced: false,
      stopId: "stop:11111111-2222-3333-4444-555555555555",
    });

    await postSlackEvent({
      type: "agent_session_stopped",
      channel: "D0AFEC7BEMP",
      thread_ts: "1787785660.512159",
      event_ts: "1787785700.000100",
      user: "U0678NQJ2",
    });

    expect(mocks.logErrorMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        errorName: "AgentSessionStopped",
        errorCode: "agent_session_stopped_receipt",
        context: expect.objectContaining({ displaced: false, stopFailed: false }),
      }),
    );
  });

  it("a receipt-insert failure still returns 200 and still stops the turn", async () => {
    mocks.dbInsertValuesMock.mockRejectedValueOnce(
      new Error("stop_events table missing"),
    );

    const response = await postSlackEvent({
      type: "agent_session_stopped",
      channel: "D0AFEC7BEMP",
      thread_ts: "1787785660.512159",
      event_ts: "1787785700.000100",
      user: "U0678NQJ2",
    });

    expect(response.status).toBe(200);
    // The stop itself went through before the receipt failed…
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
    // …and the failure was recorded as its own non-fatal error.
    expect(mocks.recordErrorMock).toHaveBeenCalledExactlyOnceWith(
      "stop_event_receipt",
      expect.any(Error),
      expect.objectContaining({ channelId: "D0AFEC7BEMP" }),
    );
  });

  it("still clears the session status and writes a receipt when stopping the lock fails", async () => {
    mocks.stopInvocationMock.mockRejectedValueOnce(new Error("db down"));
    mocks.trySetAgentSessionStatusMock.mockResolvedValueOnce(false);

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
    // Failure path still leaves a durable, queryable receipt.
    expect(mocks.logErrorMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        errorName: "AgentSessionStopped",
        errorMessage: expect.stringContaining("stopInvocation failed: db down"),
        errorCode: "agent_session_stopped_receipt",
        context: expect.objectContaining({
          displaced: null,
          statusCleared: false,
          stopFailed: true,
        }),
      }),
    );
  });

  it("acks and does nothing without channel/thread_ts", async () => {
    const response = await postSlackEvent({ type: "agent_session_stopped", user: "U0678NQJ2" });
    expect(response.status).toBe(200);
    expect(mocks.stopInvocationMock).not.toHaveBeenCalled();
    expect(mocks.trySetAgentSessionStatusMock).not.toHaveBeenCalled();
    expect(mocks.runPipelineMock).not.toHaveBeenCalled();
    expect(mocks.logErrorMock).not.toHaveBeenCalled();
  });
});

describe("Slack retry middleware (issue #1355)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.waitUntilPromises.length = 0;
    mocks.logErrorMock.mockResolvedValue(undefined);
  });

  it("acks a retried agent_session_stopped without processing but leaves a durable trace", async () => {
    const response = await postSlackEvent(
      {
        type: "agent_session_stopped",
        channel: "D0AFEC7BEMP",
        thread_ts: "1787785660.512159",
        event_ts: "1787785700.000100",
        user: "U0678NQJ2",
      },
      { "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" },
    );

    expect(response.status).toBe(200);
    // Retry semantics unchanged: nothing is processed…
    expect(mocks.stopInvocationMock).not.toHaveBeenCalled();
    expect(mocks.trySetAgentSessionStatusMock).not.toHaveBeenCalled();
    expect(mocks.runPipelineMock).not.toHaveBeenCalled();
    // …but the dropped stop retry is durably visible.
    expect(mocks.logErrorMock).toHaveBeenCalledExactlyOnceWith({
      errorName: "AgentSessionStopped",
      errorMessage:
        "agent_session_stopped retry acked without processing (retry 1: http_timeout)",
      errorCode: "agent_session_stopped_retry_ack",
      channelId: "D0AFEC7BEMP",
      userId: "U0678NQJ2",
      context: {
        threadTs: "1787785660.512159",
        eventTs: "1787785700.000100",
        retryNum: "1",
        retryReason: "http_timeout",
      },
    });
  });

  it("acks retried non-stop events without processing and without a durable row", async () => {
    const response = await postSlackEvent(
      { type: "message", channel: "C123", user: "U123", text: "hi" },
      { "x-slack-retry-num": "2", "x-slack-retry-reason": "http_error" },
    );

    expect(response.status).toBe(200);
    expect(mocks.runPipelineMock).not.toHaveBeenCalled();
    expect(mocks.logErrorMock).not.toHaveBeenCalled();
  });
});

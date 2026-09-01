import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";
process.env.SLACK_SIGNING_SECRET = "slack-signing-secret";
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

const mocks = vi.hoisted(() => ({
  upsertAppContextMock: vi.fn(async () => undefined),
  recordErrorMock: vi.fn(),
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

vi.mock("./lib/app-context.js", () => ({
  upsertAppContext: mocks.upsertAppContextMock,
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
  publishHomeTab: vi.fn(),
}));

vi.mock("./slack/thread-bootstrap.js", () => ({
  bootstrapAssistantThread: vi.fn(),
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
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
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
  bodyExtras: Record<string, unknown> = {},
) {
  const rawBody = JSON.stringify({
    type: "event_callback",
    team_id: "T123",
    event,
    ...bodyExtras,
  });
  const response = await app.request("/api/slack/events", {
    method: "POST",
    headers: slackHeaders(rawBody),
    body: rawBody,
  });
  await Promise.all(mocks.waitUntilPromises);
  return response;
}

const channelEntity = {
  type: "slack#/types/channel_id",
  value: "C0123ABCDE",
  team_id: "T123",
};

describe("app_context_changed (agent context)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.waitUntilPromises.length = 0;
    mocks.upsertAppContextMock.mockResolvedValue(undefined);
  });

  it("caches the entities for the event's user and never hits the pipeline", async () => {
    const response = await postSlackEvent({
      type: "app_context_changed",
      user: "U123",
      event_ts: "1788249000.000100",
      context: { entities: [channelEntity] },
    });

    expect(response.status).toBe(200);
    expect(mocks.upsertAppContextMock).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      userId: "U123",
      entities: [channelEntity],
      eventTs: "1788249000.000100",
    });
    expect(mocks.runPipelineMock).not.toHaveBeenCalled();
    expect(mocks.recordErrorMock).not.toHaveBeenCalled();
  });

  it("falls back to authorizations[0].user_id when the event carries no user", async () => {
    const response = await postSlackEvent(
      {
        type: "app_context_changed",
        event_ts: "1788249000.000100",
        context: { entities: [channelEntity] },
      },
      { authorizations: [{ team_id: "T123", user_id: "U456", is_bot: false }] },
    );

    expect(response.status).toBe(200);
    expect(mocks.upsertAppContextMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: "U456" }),
    );
  });

  it("stores an empty entities array (user navigated away) rather than skipping", async () => {
    const response = await postSlackEvent({
      type: "app_context_changed",
      user: "U123",
      event_ts: "1788249000.000100",
      context: {},
    });

    expect(response.status).toBe(200);
    expect(mocks.upsertAppContextMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: "U123", entities: [] }),
    );
  });

  it("acks and does nothing when no user is resolvable", async () => {
    const response = await postSlackEvent({
      type: "app_context_changed",
      context: { entities: [channelEntity] },
    });

    expect(response.status).toBe(200);
    expect(mocks.upsertAppContextMock).not.toHaveBeenCalled();
    expect(mocks.recordErrorMock).not.toHaveBeenCalled();
  });

  it("an upsert failure is recorded and still returns 200", async () => {
    mocks.upsertAppContextMock.mockRejectedValueOnce(new Error("db down"));

    const response = await postSlackEvent({
      type: "app_context_changed",
      user: "U123",
      context: { entities: [channelEntity] },
    });

    expect(response.status).toBe(200);
    expect(mocks.recordErrorMock).toHaveBeenCalledExactlyOnceWith(
      "app_context_changed",
      expect.any(Error),
      { userId: "U123" },
    );
  });
});

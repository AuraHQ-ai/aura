import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";
process.env.SLACK_SIGNING_SECRET = "slack-signing-secret";
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

const mocks = vi.hoisted(() => ({
  bootstrapAssistantThreadMock: vi.fn(),
  publishHomeTabMock: vi.fn(),
  recordErrorMock: vi.fn(),
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
  runPipeline: vi.fn(),
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

describe("assistant thread bootstrap wiring (SLACK_AGENT_VIEW dual-path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.waitUntilPromises.length = 0;
    delete process.env.SLACK_AGENT_VIEW;
    mocks.bootstrapAssistantThreadMock.mockResolvedValue(undefined);
    mocks.publishHomeTabMock.mockResolvedValue(undefined);
  });

  describe("flag off (default)", () => {
    it("assistant_thread_started triggers the thread bootstrap", async () => {
      const response = await postSlackEvent({
        type: "assistant_thread_started",
        assistant_thread: {
          channel_id: "D123",
          thread_ts: "1724264405.531769",
        },
      });

      expect(response.status).toBe(200);
      expect(
        mocks.bootstrapAssistantThreadMock,
      ).toHaveBeenCalledExactlyOnceWith({
        client: expect.anything(),
        channelId: "D123",
        threadTs: "1724264405.531769",
      });
    });

    it("app_home_opened (messages tab) does NOT bootstrap; home tab still published", async () => {
      const response = await postSlackEvent({
        type: "app_home_opened",
        user: "U123",
        channel: "D123",
        tab: "messages",
      });

      expect(response.status).toBe(200);
      expect(mocks.bootstrapAssistantThreadMock).not.toHaveBeenCalled();
      expect(mocks.publishHomeTabMock).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        "U123",
      );
    });

    it("bootstrap failures are recorded, never thrown", async () => {
      mocks.bootstrapAssistantThreadMock.mockRejectedValueOnce(
        new Error("slack down"),
      );

      const response = await postSlackEvent({
        type: "assistant_thread_started",
        assistant_thread: { channel_id: "D123", thread_ts: "1.2" },
      });

      expect(response.status).toBe(200);
      expect(mocks.recordErrorMock).toHaveBeenCalledWith(
        "assistant_thread_started",
        expect.any(Error),
      );
    });
  });

  describe("flag on", () => {
    beforeEach(() => {
      process.env.SLACK_AGENT_VIEW = "on";
    });

    it("assistant_thread_started does NOT bootstrap (event retired under agent view)", async () => {
      const response = await postSlackEvent({
        type: "assistant_thread_started",
        assistant_thread: {
          channel_id: "D123",
          thread_ts: "1724264405.531769",
        },
      });

      expect(response.status).toBe(200);
      expect(mocks.bootstrapAssistantThreadMock).not.toHaveBeenCalled();
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
});

import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";
process.env.CURSOR_WEBHOOK_SECRET = "cursor-secret";
process.env.AURA_ADMIN_USER_IDS = "UADMIN";

const mocks = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getCredentialMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  recordErrorMock: vi.fn(),
  resolveSlackDestinationMock: vi.fn(),
  safePostMessageMock: vi.fn(),
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
  publishHomeTab: vi.fn(),
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
  },
}));

vi.mock("./lib/settings.js", () => ({
  getConfig: vi.fn(async (_key: string, fallback?: string) => fallback ?? ""),
  setSetting: vi.fn(),
}));

vi.mock("./lib/logger.js", () => ({
  logger: {
    info: mocks.loggerInfoMock,
    warn: mocks.loggerWarnMock,
    error: vi.fn(),
  },
}));

vi.mock("./tools/slack.js", () => ({
  resolveSlackDestination: mocks.resolveSlackDestinationMock,
}));

vi.mock("./lib/metrics.js", () => ({
  recordError: mocks.recordErrorMock,
}));

vi.mock("./lib/slack-messaging.js", () => ({
  safePostMessage: mocks.safePostMessageMock,
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
  getCredential: mocks.getCredentialMock,
}));

const app = (await import("./app.js")).default;

function sign(rawBody: string): string {
  return (
    "sha256=" +
    crypto
      .createHmac("sha256", process.env.CURSOR_WEBHOOK_SECRET!)
      .update(rawBody, "utf8")
      .digest("hex")
  );
}

describe("Cursor agent webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.waitUntilPromises.length = 0;
    process.env.CURSOR_WEBHOOK_SECRET = "cursor-secret";
    process.env.AURA_ADMIN_USER_IDS = "UADMIN";
    mocks.getCredentialMock.mockResolvedValue("gh-token");
    mocks.resolveSlackDestinationMock.mockResolvedValue("DADMIN");
    mocks.safePostMessageMock.mockResolvedValue({ ok: true });
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://api.github.com/graphql") {
        return {
          ok: false,
          status: 500,
          json: vi.fn(async () => ({ message: "github down" })),
        } as unknown as Response;
      }

      return {
        ok: true,
        status: 200,
        json: vi.fn(async () => ({ title: "Fix webhook" })),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", mocks.fetchMock);
  });

  it("logs GitHub ready failures and still sends the PR notification", async () => {
    const rawBody = JSON.stringify({
      status: "FINISHED",
      target: {
        prUrl: "https://github.com/AuraHQ-ai/aura/pull/1037",
      },
    });

    const response = await app.request("/api/webhook/cursor-agent", {
      method: "POST",
      headers: {
        "x-webhook-signature": sign(rawBody),
        "content-type": "application/json",
      },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await Promise.all(mocks.waitUntilPromises);

    expect(mocks.loggerWarnMock).toHaveBeenCalledWith(
      "Cursor agent webhook: failed to mark PR ready for review",
      {
        owner: "AuraHQ-ai",
        repo: "aura",
        number: 1037,
        error: "GitHub GraphQL request failed (500): github down",
      },
    );
    expect(mocks.safePostMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: "DADMIN",
        text: expect.stringContaining(
          "<https://github.com/AuraHQ-ai/aura/pull/1037|Fix webhook>",
        ),
      }),
    );
    expect(mocks.recordErrorMock).not.toHaveBeenCalled();
  });
});

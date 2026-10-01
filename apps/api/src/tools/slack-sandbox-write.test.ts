import { beforeEach, describe, expect, it, vi } from "vitest";

const writeToSandboxMock = vi.hoisted(() =>
  vi.fn(
    async (filename: string, _data: Buffer, _userId: string) =>
      `/home/user/downloads/${filename}`,
  ),
);
const getOrCreateSandboxMock = vi.hoisted(() => vi.fn());
const downloadSlackFileMock = vi.hoisted(() => vi.fn());
const resolveUserCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/tool.js", () => ({
  defineTool: (config: any) => config,
  binaryToModelOutput: vi.fn(),
  registerToolNames: (tools: any) => tools,
  filterToolsByCredentials: (tools: any) => tools,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../lib/langfuse.js", () => ({
  aiTelemetry: {},
}));

vi.mock("../lib/permissions.js", () => ({
  resolveUserCredentials: resolveUserCredentialsMock,
}));

vi.mock("../lib/sandbox.js", () => ({
  writeToSandbox: writeToSandboxMock,
  getOrCreateSandbox: getOrCreateSandboxMock,
  resolveSandboxUserId: (userId?: string | null) => userId || "aura",
}));

vi.mock("../lib/files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/files.js")>();
  return {
    ...actual,
    downloadSlackFile: downloadSlackFileMock,
  };
});

vi.mock("./core.js", () => ({ createCoreTools: vi.fn(async () => ({})) }));
vi.mock("./browser.js", () => ({ createBrowserTools: () => ({}) }));
vi.mock("./jobs.js", () => ({ createJobTools: () => ({}) }));
vi.mock("./lists.js", () => ({ createListWriteTools: () => ({}) }));
vi.mock("./table.js", () => ({ createTableTools: () => ({}) }));
vi.mock("./chart.js", () => ({ createChartTools: () => ({}) }));
vi.mock("./card.js", () => ({ createCardTools: () => ({}) }));
vi.mock("./subagents.js", () => ({ createSubagentTools: () => ({}) }));
vi.mock("./voice.js", () => ({ createVoiceTools: () => ({}) }));
vi.mock("./email-sync.js", () => ({ createEmailSyncTools: () => ({}) }));
vi.mock("./scratchpad.js", () => ({ createScratchpadTools: () => ({}) }));
vi.mock("./deferred.js", () => ({ applyAnthropicToolDiscovery: vi.fn() }));
vi.mock("../lib/format.js", () => ({ formatForSlack: (value: string) => value }));
vi.mock("../lib/slack-messaging.js", () => ({ safePostMessage: vi.fn() }));
vi.mock("../lib/temporal.js", () => ({ formatTimestamp: vi.fn() }));
vi.mock("../db/client.js", () => ({ db: {} }));

import { createSlackTools } from "./slack.js";

const CALLER_ID = "UJOAN";
const FILE_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function fakeClient() {
  return {
    files: {
      info: vi.fn().mockResolvedValue({
        file: {
          name: "ubiflow-invoice.pdf",
          mimetype: "application/pdf",
          size: FILE_BYTES.length,
          url_private_download: "https://files.slack.com/ubiflow-invoice.pdf",
        },
      }),
    },
  } as any;
}

describe("download_slack_file save_to_disk sandbox identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    resolveUserCredentialsMock.mockResolvedValue(new Set(["e2b_api_key"]));
    downloadSlackFileMock.mockResolvedValue(FILE_BYTES);
    writeToSandboxMock.mockImplementation(
      async (filename: string) => `/home/user/downloads/${filename}`,
    );
  });

  it("writes to the caller's sandbox", async () => {
    const tools = await createSlackTools(fakeClient(), { userId: CALLER_ID });
    const result = await (tools.download_slack_file as any).execute({
      file_id: "F123",
      save_to_disk: true,
    });

    expect(result).toMatchObject({
      ok: true,
      saved_to_disk: true,
      path: "/home/user/downloads/ubiflow-invoice.pdf",
    });
    expect(writeToSandboxMock).toHaveBeenCalledTimes(1);
    expect(writeToSandboxMock).toHaveBeenCalledWith(
      "ubiflow-invoice.pdf",
      expect.any(Buffer),
      CALLER_ID,
    );
  });

  it("falls back to aura for heartbeat/self jobs with no caller", async () => {
    const tools = await createSlackTools(fakeClient(), {});
    const result = await (tools.download_slack_file as any).execute({
      file_id: "F123",
      save_to_disk: true,
    });

    expect(result.ok).toBe(true);
    expect(writeToSandboxMock).toHaveBeenCalledWith(
      "ubiflow-invoice.pdf",
      expect.any(Buffer),
      "aura",
    );
  });
});

describe("upload_file file_path sandbox identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveUserCredentialsMock.mockResolvedValue(new Set(["e2b_api_key"]));
    getOrCreateSandboxMock.mockResolvedValue({
      files: {
        read: vi.fn().mockResolvedValue(FILE_BYTES),
      },
    });
  });

  it("reads file_path from the caller's sandbox, not the unscoped one", async () => {
    const tools = await createSlackTools(fakeClient(), { userId: CALLER_ID });
    await (tools.upload_file as any).execute({
      file_path: "/home/user/downloads/ubiflow-invoice.pdf",
      filename: "ubiflow-invoice.pdf",
    });

    expect(getOrCreateSandboxMock).toHaveBeenCalledWith(CALLER_ID);
  });
});

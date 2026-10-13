import { beforeEach, describe, expect, it, vi } from "vitest";

const writeToSandboxMock = vi.hoisted(() =>
  vi.fn(
    async (filename: string, _data: Buffer, _userId: string) =>
      `/home/user/downloads/${filename}`,
  ),
);
const resolveSlackUserIdMock = vi.hoisted(() => vi.fn());
const hasRoleMock = vi.hoisted(() => vi.fn());
const getUserEmailAttachmentMock = vi.hoisted(() => vi.fn());
const readUserEmailMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/tool.js", () => ({
  defineTool: (config: any) => config,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../lib/permissions.js", () => ({
  hasRole: hasRoleMock,
}));

vi.mock("../lib/resolve-user.js", () => ({
  resolveSlackUserId: resolveSlackUserIdMock,
  resolveEffectiveUserId: vi.fn(),
}));

vi.mock("../lib/settings.js", () => ({
  getConfig: vi.fn(async (_key: string, fallback: string) => fallback),
}));

vi.mock("../lib/sandbox.js", () => ({
  writeToSandbox: writeToSandboxMock,
  resolveSandboxUserId: (userId?: string | null) => userId || "aura",
}));

vi.mock("../lib/gmail.js", () => ({
  getUserEmailAttachment: getUserEmailAttachmentMock,
  readUserEmail: readUserEmailMock,
}));

import { createGmailEATools } from "./email.js";

const CALLER_ID = "UJOAN";
const MAILBOX_OWNER_ID = "UOTHER";
const ATTACHMENT_BYTES = Buffer.from("invoice-pdf");

describe("download_email_attachment save_to_disk sandbox identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasRoleMock.mockResolvedValue(true);
    resolveSlackUserIdMock.mockResolvedValue(MAILBOX_OWNER_ID);
    getUserEmailAttachmentMock.mockResolvedValue({
      data: ATTACHMENT_BYTES.toString("base64"),
      size: ATTACHMENT_BYTES.length,
    });
    readUserEmailMock.mockResolvedValue(null);
    writeToSandboxMock.mockImplementation(
      async (filename: string) => `/home/user/downloads/${filename}`,
    );
  });

  it("writes to the caller's sandbox, not the mailbox owner's", async () => {
    const tools = createGmailEATools({ userId: CALLER_ID });
    const result = await (tools.download_email_attachment as any).execute({
      user_name: "Other",
      message_id: "msg-1",
      attachment_id: "att-1",
      filename: "ubiflow-invoice.pdf",
      save_to_disk: true,
    });

    expect(result).toMatchObject({
      ok: true,
      saved_to_disk: true,
      path: "/home/user/downloads/ubiflow-invoice.pdf",
    });
    expect(getUserEmailAttachmentMock).toHaveBeenCalledWith(
      MAILBOX_OWNER_ID,
      "msg-1",
      "att-1",
    );
    expect(writeToSandboxMock).toHaveBeenCalledTimes(1);
    expect(writeToSandboxMock).toHaveBeenCalledWith(
      "ubiflow-invoice.pdf",
      expect.any(Buffer),
      CALLER_ID,
    );
    expect(writeToSandboxMock.mock.calls[0][2]).not.toBe(MAILBOX_OWNER_ID);
  });

  it("writes to the caller's sandbox when downloading their own mailbox", async () => {
    const tools = createGmailEATools({ userId: CALLER_ID });
    const result = await (tools.download_email_attachment as any).execute({
      message_id: "msg-1",
      attachment_id: "att-1",
      filename: "ubiflow-invoice.pdf",
      save_to_disk: true,
    });

    expect(result.ok).toBe(true);
    expect(writeToSandboxMock).toHaveBeenCalledWith(
      "ubiflow-invoice.pdf",
      expect.any(Buffer),
      CALLER_ID,
    );
  });

  it("falls back to aura for heartbeat/self jobs with no caller", async () => {
    const tools = createGmailEATools({});
    const result = await (tools.download_email_attachment as any).execute({
      message_id: "msg-1",
      attachment_id: "att-1",
      filename: "ubiflow-invoice.pdf",
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

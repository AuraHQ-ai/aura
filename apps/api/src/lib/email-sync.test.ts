import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const insertValues = vi.fn((rows: unknown[]) => ({
    onConflictDoNothing: vi.fn(async () => ({
      rowCount: Array.isArray(rows) ? rows.length : 1,
    })),
  }));

  return {
    getGmailClientForUser: vi.fn(),
    getHeader: vi.fn((headers: Array<{ name: string; value: string }>, name: string) =>
      headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? "",
    ),
    extractBodyParts: vi.fn(() => ({ html: "", plain: "Email body" })),
    hasAttachmentParts: vi.fn(() => false),
    logError: vi.fn(),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    insert: vi.fn(() => ({
      values: insertValues,
    })),
    insertValues,
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([])),
        })),
      })),
    })),
    resolveOrCreateFromEmail: vi.fn(async () => ({})),
    embedTexts: vi.fn(async () => []),
  };
});

vi.mock("../db/client.js", () => ({
  db: {
    insert: mocks.insert,
    selectDistinct: mocks.selectDistinct,
  },
}));

vi.mock("./gmail.js", () => ({
  getGmailClientForUser: mocks.getGmailClientForUser,
  getHeader: mocks.getHeader,
  extractBodyParts: mocks.extractBodyParts,
  hasAttachmentParts: mocks.hasAttachmentParts,
}));

vi.mock("./error-logger.js", () => ({
  logError: mocks.logError,
}));

vi.mock("./logger.js", () => ({
  logger: mocks.logger,
}));

vi.mock("./person-resolution.js", () => ({
  resolveOrCreateFromEmail: mocks.resolveOrCreateFromEmail,
}));

vi.mock("./embeddings.js", () => ({
  embedTexts: mocks.embedTexts,
}));

function gmailMessage(id: string) {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: ["INBOX"],
    payload: {
      headers: [
        { name: "From", value: "Sender <sender@example.com>" },
        { name: "To", value: "User <user@example.com>" },
        { name: "Subject", value: "Test email" },
        { name: "Date", value: "Thu, 21 May 2026 07:00:35 +0000" },
      ],
    },
  };
}

function batchResponse(messages: unknown[]): Response {
  const boundary = "batch_response";
  const body = messages
    .map(
      (message, index) =>
        [
          `--${boundary}`,
          "Content-Type: application/http",
          `Content-ID: <response-item${index}>`,
          "",
          "HTTP/1.1 200 OK",
          "Content-Type: application/json; charset=UTF-8",
          "",
          JSON.stringify(message),
        ].join("\r\n"),
    )
    .join("\r\n");

  return new Response(`${body}\r\n--${boundary}--`, {
    status: 200,
    headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
  });
}

function setupGmailList(messageIds: string[]) {
  const list = vi.fn(async () => ({
    data: {
      messages: messageIds.map((id) => ({ id })),
    },
  }));

  mocks.getGmailClientForUser.mockResolvedValue({
    client: {
      users: {
        messages: { list },
      },
    },
    email: "user@example.com",
    oauth2Client: {
      getAccessToken: vi.fn(async () => ({ token: "access-token" })),
    },
  });

  return list;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());

  const immediateSetTimeout = ((
    callback: (...args: unknown[]) => void,
    _delay?: number,
    ...args: unknown[]
  ) => {
    callback(...args);
    return 0 as any;
  }) as typeof setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(immediateSetTimeout);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("syncEmails batch_api_miss retry logging", () => {
  it("does not create error events when a transient batch_api_miss is recovered", async () => {
    setupGmailList(["msg-1"]);
    vi.mocked(fetch)
      .mockResolvedValueOnce(batchResponse([]))
      .mockResolvedValueOnce(batchResponse([gmailMessage("msg-1")]));

    const { syncEmails } = await import("./email-sync.js");
    const result = await syncEmails("U123", {
      query: "newer_than:1d",
      maxMessages: 1,
    });

    expect(result).toMatchObject({
      synced: 1,
      skipped: 0,
      errors: 0,
      errorDetails: [],
    });
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "Email sync: batch_api_miss before retry",
      expect.objectContaining({
        userId: "U123",
        gmailMessageId: "msg-1",
      }),
    );
    expect(mocks.insertValues).toHaveBeenCalledWith([
      expect.objectContaining({ gmailMessageId: "msg-1" }),
    ]);
  });

  it("creates a permanent miss error event only after retry also misses", async () => {
    setupGmailList(["msg-1"]);
    vi.mocked(fetch)
      .mockResolvedValueOnce(batchResponse([]))
      .mockResolvedValueOnce(batchResponse([]));

    const { syncEmails } = await import("./email-sync.js");
    const result = await syncEmails("U123", {
      query: "newer_than:1d",
      maxMessages: 1,
    });

    expect(result.errors).toBe(1);
    expect(result.errorDetails).toEqual([
      {
        gmailMessageId: "msg-1",
        reason: "batch_api_miss_persisted: message ID still not returned by batch API after retry",
      },
    ]);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorName: "EmailSyncPermanentMiss",
        errorCode: "email_sync_permanent_miss",
        userId: "U123",
        context: {
          gmailMessageId: "msg-1",
          retryAttempted: true,
        },
      }),
    );
    expect(mocks.logError).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "email_sync_error" }),
    );
  });
});

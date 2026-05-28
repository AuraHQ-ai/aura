import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordErrorMock = vi.hoisted(() => vi.fn());
const runPipelineMock = vi.hoisted(() => vi.fn());
const getConfigMock = vi.hoisted(() => vi.fn());
const executionContextRunMock = vi.hoisted(() => vi.fn((_context, fn) => fn()));

vi.mock("../db/client.js", () => ({
  db: {},
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../lib/metrics.js", () => ({
  recordError: recordErrorMock,
}));

vi.mock("../lib/settings.js", () => ({
  getConfig: getConfigMock,
}));

vi.mock("../lib/tool.js", () => ({
  executionContext: {
    run: executionContextRunMock,
  },
}));

vi.mock("../pipeline/index.js", () => ({
  runPipeline: runPipelineMock,
}));

import {
  buildDetachedCommandResultMessage,
  createSandboxCommandWebhookApp,
  verifySandboxWebhookSignature,
} from "./sandbox-command.js";

function sign(rawBody: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

function createDatabaseMock(row: any) {
  let currentRow = row;
  const limit = vi.fn(async () => currentRow ? [currentRow] : []);
  const whereSelect = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: whereSelect }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => currentRow ? [currentRow] : []);
  const whereUpdate = vi.fn(() => ({ returning }));
  const set = vi.fn((values: Record<string, unknown>) => {
    if (currentRow) currentRow = { ...currentRow, ...values };
    return { where: whereUpdate };
  });
  const update = vi.fn(() => ({ set }));

  return {
    database: { select, update },
    calls: { select, from, whereSelect, limit, update, set, whereUpdate, returning },
  };
}

describe("sandbox command webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SANDBOX_WEBHOOK_SECRET = "sandbox-secret";
    runPipelineMock.mockResolvedValue(undefined);
    getConfigMock.mockResolvedValue("U_AURA");
    executionContextRunMock.mockImplementation((_context, fn) => fn());
  });

  it("verifies HMAC signatures", () => {
    const body = JSON.stringify({ id: "abcdef12", exit_code: 0 });
    const signature = sign(body, "sandbox-secret");

    expect(verifySandboxWebhookSignature(body, signature, "sandbox-secret")).toBe(true);
    expect(verifySandboxWebhookSignature(body, "sha256=bad", "sandbox-secret")).toBe(false);
  });

  it("rejects invalid signatures", async () => {
    const { database } = createDatabaseMock(null);
    const app = createSandboxCommandWebhookApp({} as any, database);

    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": "sha256=bad",
      },
      body: JSON.stringify({ id: "abcdef12", exit_code: 0 }),
    });

    expect(response.status).toBe(401);
  });

  it("formats detached command results as a synthetic user turn payload", () => {
    const startedAt = new Date("2026-05-28T08:00:00Z");
    const completedAt = new Date("2026-05-28T08:00:42Z");
    const message = buildDetachedCommandResultMessage(
      {
        id: "abcdef12",
        workspaceId: "default",
        pid: 4321,
        command: "pnpm test",
        status: "completed",
        exitCode: 0,
        requestedBy: "U123",
        channelId: "C123",
        threadTs: "1710000000.000000",
        startedAt,
        completedAt,
        stdoutTail: null,
        stderrTail: null,
      },
      0,
      "last stdout",
      "",
      completedAt,
    );

    expect(message).toContain('<detached-command-result id="abcdef12" exit_code=0 runtime_s=42>');
    expect(message).toContain("_Command:_ `pnpm test`");
    expect(message).toContain("*stdout tail:*");
    expect(message).toContain("last stdout");
    expect(message).toContain("</detached-command-result>");
  });

  it("updates the detached command row and enqueues a synthetic resume", async () => {
    const startedAt = new Date(Date.now() - 2_000);
    const row = {
      id: "abcdef12",
      workspaceId: "default",
      pid: 4321,
      command: "pnpm test",
      status: "running",
      exitCode: null,
      requestedBy: "U123",
      channelId: "C123",
      threadTs: "1710000000.000000",
      startedAt,
      completedAt: null,
      stdoutTail: null,
      stderrTail: null,
    };
    const { database, calls } = createDatabaseMock(row);
    const resumeConversation = vi.fn().mockResolvedValue(undefined);
    const enqueued: Promise<void>[] = [];
    const app = createSandboxCommandWebhookApp({ chat: { postMessage: vi.fn() } } as any, database, {
      resumeConversation,
      enqueueResume: (promise) => enqueued.push(promise),
    });
    const body = JSON.stringify({
      id: "abcdef12",
      exit_code: 1,
      stdout_tail: "last stdout",
      stderr_tail: "last stderr",
    });

    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sign(body, "sandbox-secret"),
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, resumed: true });
    expect(calls.set).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      exitCode: 1,
      stdoutTail: "last stdout",
      stderrTail: "last stderr",
    }));
    expect(resumeConversation).toHaveBeenCalledWith(expect.objectContaining({
      row: expect.objectContaining({
        id: "abcdef12",
        channelId: "C123",
        threadTs: "1710000000.000000",
      }),
      exitCode: 1,
      stdoutTail: "last stdout",
      stderrTail: "last stderr",
      slackClient: expect.anything(),
    }));
    expect(enqueued).toHaveLength(1);
  });

  it("routes the default synthetic resume through runPipeline with the command result", async () => {
    const startedAt = new Date(Date.now() - 1_000);
    const row = {
      id: "abcdef12",
      workspaceId: "default",
      pid: 4321,
      command: "pnpm test",
      status: "running",
      exitCode: null,
      requestedBy: "U123",
      channelId: "C123",
      threadTs: "1710000000.000000",
      startedAt,
      completedAt: null,
      stdoutTail: null,
      stderrTail: null,
    };
    const { database } = createDatabaseMock(row);
    const enqueued: Promise<void>[] = [];
    const slackClient = { chat: { postMessage: vi.fn() } } as any;
    const app = createSandboxCommandWebhookApp(slackClient, database, {
      enqueueResume: (promise) => enqueued.push(promise),
    });
    const body = JSON.stringify({
      id: "abcdef12",
      exit_code: 0,
      stdout_tail: "ok",
      stderr_tail: "",
    });

    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sign(body, "sandbox-secret"),
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, resumed: true });
    expect(enqueued).toHaveLength(1);
    await enqueued[0];

    expect(executionContextRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        triggeredBy: "U123",
        channelId: "C123",
        threadTs: "1710000000.000000",
        workspaceId: "default",
      }),
      expect.any(Function),
    );
    expect(runPipelineMock).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({
        type: "app_mention",
        channel: "C123",
        thread_ts: "1710000000.000000",
        user: "U123",
        text: expect.stringContaining("<detached-command-result"),
      }),
      client: slackClient,
      botUserId: "U_AURA",
    }));
    expect(runPipelineMock.mock.calls[0]?.[0].event.text).toContain("_Command:_ `pnpm test`");
    expect(runPipelineMock.mock.calls[0]?.[0].event.text).toContain("*stdout tail:*");
    expect(runPipelineMock.mock.calls[0]?.[0].event.text).toContain("ok");
  });

  it("skips duplicate synthetic resumes for curl retry payloads", async () => {
    const row = {
      id: "abcdef12",
      workspaceId: "default",
      pid: 4321,
      command: "sleep 1",
      status: "running",
      exitCode: null,
      requestedBy: "U123",
      channelId: "C123",
      threadTs: "1710000000.000000",
      startedAt: new Date(Date.now() - 1_000),
      completedAt: null,
      stdoutTail: null,
      stderrTail: null,
    };
    const { database } = createDatabaseMock(row);
    const resumeConversation = vi.fn().mockResolvedValue(undefined);
    const app = createSandboxCommandWebhookApp({ chat: { postMessage: vi.fn() } } as any, database, {
      resumeConversation,
      enqueueResume: () => undefined,
    });
    const body = JSON.stringify({
      id: "abcdef12",
      exit_code: 0,
      stdout_tail: "done",
      stderr_tail: "",
    });
    const headers = {
      "content-type": "application/json",
      "x-webhook-signature": sign(body, "sandbox-secret"),
    };

    const first = await app.request("/", {
      method: "POST",
      headers,
      body,
    });
    const second = await app.request("/", {
      method: "POST",
      headers,
      body,
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, resumed: true });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      ok: true,
      resumed: false,
      reason: "already_notified",
    });
    expect(resumeConversation).toHaveBeenCalledTimes(1);
  });

  it("logs and no-ops when the origin thread is missing", async () => {
    const row = {
      id: "abcdef12",
      workspaceId: "default",
      pid: 4321,
      command: "sleep 1",
      status: "running",
      exitCode: null,
      requestedBy: "U123",
      channelId: null,
      threadTs: null,
      startedAt: new Date(Date.now() - 1_000),
      completedAt: null,
      stdoutTail: null,
      stderrTail: null,
    };
    const { database } = createDatabaseMock(row);
    const resumeConversation = vi.fn().mockResolvedValue(undefined);
    const app = createSandboxCommandWebhookApp({ chat: { postMessage: vi.fn() } } as any, database, {
      resumeConversation,
      enqueueResume: () => undefined,
    });
    const body = JSON.stringify({
      id: "abcdef12",
      exit_code: 0,
      stdout_tail: "done",
      stderr_tail: "",
    });

    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sign(body, "sandbox-secret"),
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, resumed: false });
    expect(resumeConversation).not.toHaveBeenCalled();
  });
});

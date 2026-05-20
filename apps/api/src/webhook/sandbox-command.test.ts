import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const safePostMessageMock = vi.hoisted(() => vi.fn());
const recordErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../db/client.js", () => ({
  db: {},
}));

vi.mock("../lib/slack-messaging.js", () => ({
  safePostMessage: safePostMessageMock,
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

import {
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
    safePostMessageMock.mockResolvedValue({ ok: true });
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

  it("updates the detached command row and posts a Slack notification", async () => {
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
    const app = createSandboxCommandWebhookApp({ chat: { postMessage: vi.fn() } } as any, database);
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
    expect(await response.json()).toEqual({ ok: true, notified: true });
    expect(calls.set).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      exitCode: 1,
      stdoutTail: "last stdout",
      stderrTail: "last stderr",
    }));
    expect(safePostMessageMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      channel: "C123",
      thread_ts: "1710000000.000000",
      text: expect.stringContaining("Detached command `abcdef12` failed with exit code 1"),
    }));
  });

  it("skips duplicate Slack notifications for curl retry payloads", async () => {
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
    const app = createSandboxCommandWebhookApp({ chat: { postMessage: vi.fn() } } as any, database);
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
    expect(await first.json()).toEqual({ ok: true, notified: true });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      ok: true,
      notified: false,
      reason: "already_notified",
    });
    expect(safePostMessageMock).toHaveBeenCalledTimes(1);
  });
});

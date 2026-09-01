import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordErrorMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  db: {},
}));

vi.mock("../lib/logger.js", () => ({
  logger: loggerMock,
}));

vi.mock("../lib/metrics.js", () => ({
  recordError: recordErrorMock,
}));

import {
  createGitHubWebhookApp,
  parseClosingIssueReferences,
  verifyGitHubWebhookSignature,
} from "./github.js";

const SECRET = "github-webhook-secret";

function sign(rawBody: string, secret = SECRET): string {
  return (
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  );
}

function createDatabaseMock(selectRows: any[] = []) {
  const onConflictDoUpdate = vi.fn(async () => []);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));

  const where = vi.fn(async () => selectRows);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  return {
    database: { insert, select },
    calls: { insert, values, onConflictDoUpdate, select, from, where },
  };
}

function request(
  app: ReturnType<typeof createGitHubWebhookApp>,
  event: string,
  payload: unknown,
  overrides: { signature?: string | null } = {},
) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": "delivery-123",
  };
  if (overrides.signature !== null) {
    headers["x-hub-signature-256"] = overrides.signature ?? sign(body);
  }
  return app.request("/", { method: "POST", headers, body });
}

function prPayload(overrides: Record<string, any> = {}) {
  const { pull_request: prOverrides, ...rest } = overrides;
  return {
    action: "opened",
    repository: { full_name: "AuraHQ-ai/aura" },
    pull_request: {
      number: 42,
      title: "feat: something",
      body: "Does a thing.\n\nFixes #7",
      html_url: "https://github.com/AuraHQ-ai/aura/pull/42",
      user: { login: "aura-vidal" },
      merged: false,
      created_at: "2026-09-01T10:00:00Z",
      merged_at: null,
      closed_at: null,
      ...prOverrides,
    },
    ...rest,
  };
}

describe("verifyGitHubWebhookSignature", () => {
  it("accepts a valid signature", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifyGitHubWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifyGitHubWebhookSignature(body, "sha256=" + "0".repeat(64), SECRET)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifyGitHubWebhookSignature(body, sign(body, "other-secret"), SECRET)).toBe(false);
  });

  it("rejects a missing signature or missing secret", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifyGitHubWebhookSignature(body, "", SECRET)).toBe(false);
    expect(verifyGitHubWebhookSignature(body, sign(body), undefined)).toBe(false);
  });

  it("rejects malformed signatures without throwing", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifyGitHubWebhookSignature(body, "not-a-signature", SECRET)).toBe(false);
  });
});

describe("parseClosingIssueReferences", () => {
  it("extracts issue numbers from closing keywords", () => {
    expect(parseClosingIssueReferences("Fixes #7")).toEqual([7]);
    expect(parseClosingIssueReferences("fixes #7, closes #12\nResolves #99")).toEqual([7, 12, 99]);
    expect(parseClosingIssueReferences("Fixed #3 and resolved #4 and closed #5")).toEqual([3, 4, 5]);
  });

  it("ignores plain references and empty bodies", () => {
    expect(parseClosingIssueReferences("See #7 for context")).toEqual([]);
    expect(parseClosingIssueReferences("")).toEqual([]);
    expect(parseClosingIssueReferences(null)).toEqual([]);
    expect(parseClosingIssueReferences(undefined)).toEqual([]);
  });

  it("deduplicates repeated references", () => {
    expect(parseClosingIssueReferences("Fixes #7\n\nfixes #7")).toEqual([7]);
  });
});

describe("GitHub webhook endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  });

  it("accepts a correctly signed payload", async () => {
    const { database } = createDatabaseMock();
    const app = createGitHubWebhookApp(database);

    const response = await request(app, "pull_request", prPayload());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, handled: true, action: "opened" });
  });

  it("rejects an invalid signature with 401 and logs the attempt", async () => {
    const { database, calls } = createDatabaseMock();
    const app = createGitHubWebhookApp(database);

    const response = await request(app, "pull_request", prPayload(), {
      signature: "sha256=" + "0".repeat(64),
    });

    expect(response.status).toBe(401);
    expect(calls.insert).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "GitHub webhook signature validation failed — rejecting",
      expect.objectContaining({ event: "pull_request", hasSignature: true }),
    );
  });

  it("rejects a missing signature with 401 and logs the attempt", async () => {
    const { database, calls } = createDatabaseMock();
    const app = createGitHubWebhookApp(database);

    const response = await request(app, "pull_request", prPayload(), { signature: null });

    expect(response.status).toBe(401);
    expect(calls.insert).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "GitHub webhook signature validation failed — rejecting",
      expect.objectContaining({ hasSignature: false }),
    );
  });

  it("rejects when GITHUB_WEBHOOK_SECRET is not configured", async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const { database } = createDatabaseMock();
    const app = createGitHubWebhookApp(database);

    const body = JSON.stringify(prPayload());
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(body),
      },
      body,
    });

    expect(response.status).toBe(403);
  });

  it("records an opened pull request with its linked issues", async () => {
    const { database, calls } = createDatabaseMock();
    const app = createGitHubWebhookApp(database);

    const response = await request(app, "pull_request", prPayload());

    expect(response.status).toBe(200);
    expect(calls.values).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "AuraHQ-ai/aura",
        number: 42,
        title: "feat: something",
        author: "aura-vidal",
        state: "open",
        linkedIssues: [7],
      }),
    );
    expect(calls.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("records a ready_for_review pull request", async () => {
    const { database, calls } = createDatabaseMock();
    const app = createGitHubWebhookApp(database);

    const response = await request(
      app,
      "pull_request",
      prPayload({ action: "ready_for_review" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      handled: true,
      action: "ready_for_review",
    });
    expect(calls.values).toHaveBeenCalledWith(
      expect.objectContaining({ state: "open" }),
    );
  });

  it("closes referenced open issues when a PR with 'Fixes #N' is merged", async () => {
    const { database } = createDatabaseMock();
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      if (!init || init.method === "GET") {
        return new Response(JSON.stringify({ state: "open", number: 7 }), { status: 200 });
      }
      return new Response(JSON.stringify({ state: "closed", number: 7 }), { status: 200 });
    });
    const app = createGitHubWebhookApp(database, { fetchImpl, githubToken: "gh-token" });

    const response = await request(
      app,
      "pull_request",
      prPayload({
        action: "closed",
        pull_request: {
          merged: true,
          merged_at: "2026-09-01T12:00:00Z",
          closed_at: "2026-09-01T12:00:00Z",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      handled: true,
      action: "closed",
      merged: true,
      closedIssues: [{ issue: 7, result: "closed" }],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [getUrl, getInit] = fetchImpl.mock.calls[0];
    expect(getUrl).toBe("https://api.github.com/repos/AuraHQ-ai/aura/issues/7");
    expect(getInit.method).toBe("GET");
    expect(getInit.headers.Authorization).toBe("token gh-token");
    const [patchUrl, patchInit] = fetchImpl.mock.calls[1];
    expect(patchUrl).toBe("https://api.github.com/repos/AuraHQ-ai/aura/issues/7");
    expect(patchInit.method).toBe("PATCH");
    expect(JSON.parse(patchInit.body)).toEqual({ state: "closed", state_reason: "completed" });
  });

  it("does not close issues that are already closed", async () => {
    const { database } = createDatabaseMock();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ state: "closed", number: 7 }), { status: 200 }),
    );
    const app = createGitHubWebhookApp(database, { fetchImpl, githubToken: "gh-token" });

    const response = await request(
      app,
      "pull_request",
      prPayload({ action: "closed", pull_request: { merged: true } }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        closedIssues: [{ issue: 7, result: "already_closed" }],
      }),
    );
    // Only the GET — no PATCH for an already-closed issue.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not touch issues when the PR is closed without merging", async () => {
    const { database, calls } = createDatabaseMock();
    const fetchImpl = vi.fn();
    const app = createGitHubWebhookApp(database, { fetchImpl, githubToken: "gh-token" });

    const response = await request(
      app,
      "pull_request",
      prPayload({
        action: "closed",
        pull_request: { merged: false, closed_at: "2026-09-01T12:00:00Z" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({ merged: false, closedIssues: [] }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.values).toHaveBeenCalledWith(
      expect.objectContaining({ state: "closed" }),
    );
  });

  it("survives a failing issue-close call (fail-soft per issue)", async () => {
    const { database } = createDatabaseMock();
    const fetchImpl = vi.fn(async () => {
      throw new Error("GitHub is down");
    });
    const app = createGitHubWebhookApp(database, { fetchImpl, githubToken: "gh-token" });

    const response = await request(
      app,
      "pull_request",
      prPayload({ action: "closed", pull_request: { merged: true } }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        closedIssues: [{ issue: 7, result: "failed" }],
      }),
    );
  });

  it("handles issues closed events and reports referencing PRs", async () => {
    const { database } = createDatabaseMock([
      { number: 42, linkedIssues: [7] },
      { number: 43, linkedIssues: [8] },
    ]);
    const app = createGitHubWebhookApp(database);

    const response = await request(app, "issues", {
      action: "closed",
      repository: { full_name: "AuraHQ-ai/aura" },
      issue: { number: 7 },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      handled: true,
      action: "closed",
      referencingPrs: [42],
    });
  });

  it("ignores unsupported pull_request actions", async () => {
    const { database, calls } = createDatabaseMock();
    const app = createGitHubWebhookApp(database);

    const response = await request(
      app,
      "pull_request",
      prPayload({ action: "synchronize" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      handled: false,
      reason: "unsupported_action",
    });
    expect(calls.insert).not.toHaveBeenCalled();
  });

  it("ignores unsupported event types", async () => {
    const { database, calls } = createDatabaseMock();
    const app = createGitHubWebhookApp(database);

    const response = await request(app, "push", { ref: "refs/heads/main" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      handled: false,
      reason: "unsupported_event",
    });
    expect(calls.insert).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const { database } = createDatabaseMock();
    const app = createGitHubWebhookApp(database);
    const body = "not-json{";

    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(body),
      },
      body,
    });

    expect(response.status).toBe(400);
  });
});

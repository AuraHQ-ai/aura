import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

const mocks = vi.hoisted(() => ({
  runSmokeChecksMock: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../lib/smoke-check.js", () => ({
  runSmokeChecks: mocks.runSmokeChecksMock,
}));

const { internalApp } = await import("./internal.js");

const okReport = {
  ok: true,
  timestamp: "2026-09-01T00:00:00.000Z",
  durationMs: 12,
  checks: [{ integration: "slack", status: "ok", latencyMs: 12 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "test-cron-secret";
  mocks.runSmokeChecksMock.mockResolvedValue(okReport);
});

describe("GET /api/internal/smoke", () => {
  it("rejects requests without an Authorization header", async () => {
    const res = await internalApp.request("/api/internal/smoke");

    expect(res.status).toBe(401);
    expect(mocks.runSmokeChecksMock).not.toHaveBeenCalled();
  });

  it("rejects requests with the wrong secret", async () => {
    const res = await internalApp.request("/api/internal/smoke", {
      headers: { Authorization: "Bearer wrong-secret" },
    });

    expect(res.status).toBe(401);
    expect(mocks.runSmokeChecksMock).not.toHaveBeenCalled();
  });

  it("rejects all requests when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;

    const res = await internalApp.request("/api/internal/smoke", {
      headers: { Authorization: "Bearer " },
    });

    expect(res.status).toBe(401);
    expect(mocks.runSmokeChecksMock).not.toHaveBeenCalled();
  });

  it("returns the smoke report with 200 when everything passed", async () => {
    const res = await internalApp.request("/api/internal/smoke", {
      headers: { Authorization: "Bearer test-cron-secret" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(okReport);
  });

  it("returns 503 when at least one integration failed", async () => {
    mocks.runSmokeChecksMock.mockResolvedValue({
      ...okReport,
      ok: false,
      checks: [
        { integration: "slack", status: "ok", latencyMs: 10 },
        {
          integration: "cursor",
          status: "failed",
          latencyMs: 20,
          reason: "http_401",
        },
      ],
    });

    const res = await internalApp.request("/api/internal/smoke", {
      headers: { Authorization: "Bearer test-cron-secret" },
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

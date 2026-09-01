import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { runSmokeChecks } = await import("./smoke-check.js");
type SmokeProbe = import("./smoke-check.js").SmokeProbe;

const okProbe: SmokeProbe = async () => ({ status: "ok" });

describe("runSmokeChecks", () => {
  it("reports ok when every probe passes", async () => {
    const report = await runSmokeChecks({ a: okProbe, b: okProbe }, 1_000);

    expect(report.ok).toBe(true);
    expect(report.checks).toHaveLength(2);
    for (const check of report.checks) {
      expect(check.status).toBe("ok");
      expect(check.latencyMs).toBeGreaterThanOrEqual(0);
      expect(check.reason).toBeUndefined();
    }
  });

  it("marks the report not-ok when any probe fails, without failing the others", async () => {
    const report = await runSmokeChecks(
      {
        good: okProbe,
        bad: async () => {
          throw new Error("boom");
        },
      },
      1_000,
    );

    expect(report.ok).toBe(false);
    const good = report.checks.find((c) => c.integration === "good");
    const bad = report.checks.find((c) => c.integration === "bad");
    expect(good?.status).toBe("ok");
    expect(bad?.status).toBe("failed");
    expect(bad?.reason).toBe("error");
  });

  it("treats skipped probes as non-failures", async () => {
    const report = await runSmokeChecks(
      {
        unconfigured: async () => ({
          status: "skipped",
          reason: "not_configured",
        }),
      },
      1_000,
    );

    expect(report.ok).toBe(true);
    expect(report.checks[0]).toMatchObject({
      integration: "unconfigured",
      status: "skipped",
      reason: "not_configured",
    });
  });

  it("times out slow probes and reports 'timeout'", async () => {
    const report = await runSmokeChecks(
      {
        slow: (signal) =>
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ status: "ok" }), 5_000);
            signal.addEventListener("abort", () => clearTimeout(timer));
          }),
      },
      50,
    );

    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({
      integration: "slow",
      status: "failed",
      reason: "timeout",
    });
  });

  it("never leaks error messages (which may contain credentials) into the report", async () => {
    const secret = "xoxb-super-secret-token-value";
    const report = await runSmokeChecks(
      {
        leaky: async () => {
          throw new Error(`request to https://x.test?token=${secret} failed`);
        },
        leakyTyped: async () => {
          const err = new Error(`Bearer ${secret} rejected`);
          err.name = "AuthenticationError";
          throw err;
        },
        leakyHttp: async () => {
          const err = new Error(`401 for token ${secret}`) as Error & {
            status: number;
          };
          err.status = 401;
          throw err;
        },
      },
      1_000,
    );

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secret);

    const byName = Object.fromEntries(
      report.checks.map((c) => [c.integration, c]),
    );
    expect(byName.leaky.reason).toBe("error");
    expect(byName.leakyTyped.reason).toBe("error_AuthenticationError");
    expect(byName.leakyHttp.reason).toBe("http_401");
  });
});

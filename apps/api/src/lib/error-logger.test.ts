import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

const dbMock = vi.hoisted(() => {
  const values = vi.fn((row: any) => Promise.resolve(row));
  const insert = vi.fn(() => ({ values }));
  return { insert, values };
});

vi.mock("../db/client.js", () => ({
  db: {
    insert: dbMock.insert,
  },
}));

vi.mock("./slack-messaging.js", () => ({
  safePostMessage: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("./logger.js", () => ({
  logger: {
    warn: vi.fn(),
  },
}));

const {
  flushLoggerDrops,
  resetErrorLoggerStateForTest,
  sanitizeErrorText,
  logError,
} = await import("./error-logger.js");

function numericArray(length: number): string {
  return `[${Array.from({ length }, (_, i) => ((i + 1) / 1000).toFixed(4)).join(",")}]`;
}

describe("sanitizeErrorText", () => {
  it("leaves clean text unchanged", () => {
    const input = "duplicate key value violates unique constraint";

    expect(sanitizeErrorText(input)).toBe(input);
  });

  it("leaves short numeric arrays unchanged", () => {
    const input = "params: [1,2,3,4,5]";

    expect(sanitizeErrorText(input)).toBe(input);
  });

  it("strips a Postgres embedding vector dump", () => {
    const input = `Failed query: insert into messages values ($1) params: ${numericArray(1536)}`;
    const output = sanitizeErrorText(input);

    expect(output).toContain("floats omitted");
    expect(output).toContain("1536 floats omitted");
    expect(output.length).toBeLessThan(500);
  });

  it("strips multiple embeddings in one message", () => {
    const input = `first=${numericArray(32)} second=${numericArray(64)}`;
    const output = sanitizeErrorText(input);

    expect(output.match(/floats omitted/g)).toHaveLength(2);
    expect(output).toContain("32 floats omitted");
    expect(output).toContain("64 floats omitted");
  });

  it("truncates long stack traces with a marker", () => {
    const input = `Error: failed\n${"at frame\n".repeat(300)}`;
    const output = sanitizeErrorText(input);

    expect(output).toContain("truncated, original");
    expect(output.length).toBeLessThan(input.length);
  });

  it("returns an empty string for nullish input", () => {
    expect(sanitizeErrorText(null)).toBe("");
    expect(sanitizeErrorText(undefined)).toBe("");
  });
});

describe("logError rate-limit drop visibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T15:00:00.000Z"));
    dbMock.insert.mockClear();
    dbMock.values.mockClear();
    resetErrorLoggerStateForTest();
  });

  afterEach(() => {
    resetErrorLoggerStateForTest();
    vi.useRealTimers();
  });

  it("flushes per-code rate-limit drops to error_events", async () => {
    for (let i = 0; i < 6; i++) {
      logError({
        errorName: "NoisyError",
        errorMessage: `noisy ${i}`,
        errorCode: "noisy_error",
      });
    }

    expect(dbMock.values).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushLoggerDrops();

    const loggerDropRows = dbMock.values.mock.calls
      .map(([row]) => row)
      .filter((row) => row.errorCode === "error_logger_drops");

    expect(loggerDropRows).toHaveLength(1);
    expect(loggerDropRows[0]).toMatchObject({
      errorName: "LoggerDrops",
      errorCode: "error_logger_drops",
      context: {
        totalDropped: 1,
        drops: {
          noisy_error: {
            count: 1,
            reasons: {
              per_code: 1,
              global: 0,
            },
          },
        },
      },
    });
  });
});

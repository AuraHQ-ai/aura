import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from "./logger.js";
import {
  capToolResult,
  DEFAULT_MAX_RESULT_CHARS,
  getToolResultCapCounts,
  resetToolResultCapCounts,
} from "./result-cap.js";

const MARKER_RE = /\.\.\. \[truncated \d+ chars of \d+.*narrow the query or paginate\]/;

beforeEach(() => {
  resetToolResultCapCounts();
  vi.clearAllMocks();
});

describe("capToolResult — pass-through", () => {
  it("leaves small results untouched (same reference)", () => {
    const result = { ok: true, rows: [1, 2, 3] };
    expect(capToolResult(result, 12000, "t")).toBe(result);
  });

  it("leaves primitives untouched", () => {
    expect(capToolResult(null, 100, "t")).toBe(null);
    expect(capToolResult(42, 100, "t")).toBe(42);
    expect(capToolResult(true, 100, "t")).toBe(true);
    expect(capToolResult("short", 100, "t")).toBe("short");
  });
});

describe("capToolResult — string truncation", () => {
  it("truncates oversized strings with a visible marker, within the cap", () => {
    const input = "x".repeat(30000);
    const out = capToolResult(input, 1000, "t") as string;
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out).toMatch(MARKER_RE);
    expect(out.startsWith("xxx")).toBe(true);
  });
});

describe("capToolResult — top-level array degradation", () => {
  it("drops items from the end and appends a marker element, keeping valid JSON", () => {
    const input = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      text: `item number ${i} with some padding text`.repeat(3),
    }));
    const out = capToolResult(input, 2000, "t") as unknown[];

    expect(Array.isArray(out)).toBe(true);
    const serialized = JSON.stringify(out);
    expect(serialized.length).toBeLessThanOrEqual(2000);
    // Round-trips as valid JSON
    expect(JSON.parse(serialized)).toEqual(out);
    // Items are a prefix of the original — no mid-JSON slicing
    const items = out.slice(0, -1);
    expect(items).toEqual(input.slice(0, items.length));
    // Last element is the visible marker
    expect(out[out.length - 1]).toMatch(MARKER_RE);
    expect(out[out.length - 1]).toContain(`of ${input.length} items`);
  });
});

describe("capToolResult — object with dominant array field", () => {
  it("halves array items until it fits, preserving the other fields", () => {
    const input = {
      ok: true,
      query: "some query",
      rows: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `row-${i}` })),
      total_rows: 500,
    };
    const out = capToolResult(input, 3000, "t") as Record<string, unknown>;

    const serialized = JSON.stringify(out);
    expect(serialized.length).toBeLessThanOrEqual(3000);
    expect(JSON.parse(serialized)).toEqual(out);
    expect(out.ok).toBe(true);
    expect(out.query).toBe("some query");
    expect(out.total_rows).toBe(500);
    expect(out._truncated).toBe(true);
    expect(out._note).toMatch(MARKER_RE);
    const rows = out.rows as unknown[];
    expect(rows.length).toBeLessThan(500);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toEqual(input.rows.slice(0, rows.length));
  });
});

describe("capToolResult — object with dominant string field", () => {
  it("truncates the string field in place with a marker, keeping the rest intact", () => {
    const input = {
      ok: true,
      url: "https://example.com",
      content: "long page content ".repeat(2000),
    };
    const out = capToolResult(input, 4000, "t") as Record<string, unknown>;

    const serialized = JSON.stringify(out);
    expect(serialized.length).toBeLessThanOrEqual(4000);
    expect(out.ok).toBe(true);
    expect(out.url).toBe("https://example.com");
    expect(out._truncated).toBe(true);
    expect(out.content).toMatch(MARKER_RE);
    expect((out.content as string).startsWith("long page content ")).toBe(true);
  });
});

describe("capToolResult — serialized fallback", () => {
  it("wraps the truncated serialization instead of emitting malformed JSON", () => {
    // Many medium-sized fields: no dominant array, no string field big enough
    // to absorb the overage.
    const input: Record<string, string> = {};
    for (let i = 0; i < 100; i++) input[`field_${i}`] = "v".repeat(100);
    const out = capToolResult(input, 2000, "t") as Record<string, unknown>;

    const serialized = JSON.stringify(out);
    expect(serialized.length).toBeLessThanOrEqual(2000);
    expect(out._truncated).toBe(true);
    expect(out.truncated_result).toMatch(MARKER_RE);
  });
});

describe("capToolResult — binary payload exemption", () => {
  it("never counts or truncates *_base64 fields (consumed by toModelOutput)", () => {
    const screenshot = "A".repeat(200000);
    const input = {
      ok: true,
      url: "https://example.com",
      screenshot_base64: screenshot,
    };
    // Way over the cap if the screenshot counted — must pass through untouched.
    const out = capToolResult(input, 1000, "browse");
    expect(out).toBe(input);
  });

  it("exempts content when encoding is base64 (drive-style results)", () => {
    const input = {
      ok: true,
      name: "report.pdf",
      content: "B".repeat(200000),
      encoding: "base64",
    };
    expect(capToolResult(input, 1000, "read_drive_file")).toBe(input);
  });

  it("caps oversized text but re-attaches the binary payload untouched", () => {
    const screenshot = "A".repeat(200000);
    const input = {
      ok: true,
      screenshot_base64: screenshot,
      extracted_content: "page text ".repeat(5000),
    };
    const out = capToolResult(input, 4000, "browse") as Record<string, unknown>;
    expect(out.screenshot_base64).toBe(screenshot);
    expect(out._truncated).toBe(true);
    expect(out.extracted_content).toMatch(MARKER_RE);
    const { screenshot_base64: _omit, ...textPart } = out;
    expect(JSON.stringify(textPart).length).toBeLessThanOrEqual(4000);
  });
});

describe("capToolResult — warning log + counter", () => {
  it("logs a warning with the tool name and increments the per-tool counter", () => {
    capToolResult("x".repeat(5000), 1000, "chatty_tool");
    capToolResult("y".repeat(5000), 1000, "chatty_tool");
    capToolResult("z".repeat(5000), 1000, "other_tool");

    expect(getToolResultCapCounts()).toEqual({ chatty_tool: 2, other_tool: 1 });
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      "Tool result exceeded cap and was truncated",
      expect.objectContaining({
        toolName: "chatty_tool",
        maxChars: 1000,
        originalChars: 5000,
        capCount: 2,
      }),
    );
  });

  it("does not count results under the cap", () => {
    capToolResult({ ok: true }, DEFAULT_MAX_RESULT_CHARS, "quiet_tool");
    expect(getToolResultCapCounts()).toEqual({});
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

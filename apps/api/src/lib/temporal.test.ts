import { describe, it, expect } from "vitest";
import { relativeTime, parseRelativeTime, formatTimestamp } from "./temporal.js";

describe("relativeTime", () => {
  const now = new Date("2026-03-03T12:00:00Z");

  it("returns 'just now' for timestamps within the last minute", () => {
    const date = new Date(now.getTime() - 30 * 1000);
    expect(relativeTime(date, now)).toBe("just now");
  });

  it("returns '5 minutes ago'", () => {
    const date = new Date(now.getTime() - 5 * 60 * 1000);
    expect(relativeTime(date, now)).toBe("5 minutes ago");
  });

  it("returns 'yesterday' for exactly 1 day ago", () => {
    const date = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    expect(relativeTime(date, now)).toBe("yesterday");
  });

  it("returns '3 days ago'", () => {
    const date = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    expect(relativeTime(date, now)).toBe("3 days ago");
  });

  it("returns 'about a week ago'", () => {
    const date = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(relativeTime(date, now)).toBe("about a week ago");
  });

  it("returns 'about 2 weeks ago'", () => {
    const date = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    expect(relativeTime(date, now)).toBe("about 2 weeks ago");
  });

  // Calendar-day counting: an event 4 calendar days earlier reads "4 days ago"
  // even when fewer than 4×24h have elapsed (event late in its day, asked in the
  // morning). Flooring elapsed time used to undercount this as "3 days ago".
  it("counts calendar days, not elapsed 24h periods", () => {
    const ref = new Date("2023-04-10T05:43:00Z");
    const date = new Date("2023-04-06T20:00:00Z"); // 3.4 days elapsed, 4 calendar days
    expect(relativeTime(date, ref)).toBe("4 days ago");
  });

  it("treats an earlier-today event as same-day, a late-yesterday event as 'yesterday'", () => {
    const ref = new Date("2026-03-03T08:00:00Z");
    expect(relativeTime(new Date("2026-03-02T22:00:00Z"), ref)).toBe("yesterday");
    expect(relativeTime(new Date("2026-03-03T02:00:00Z"), ref)).toBe("6 hours ago");
  });

  it("returns 'back in December' for dates months ago", () => {
    const date = new Date("2025-12-01T12:00:00Z");
    expect(relativeTime(date, now)).toBe("back in December");
  });

  it("returns 'in the future' for future dates", () => {
    const date = new Date(now.getTime() + 60 * 60 * 1000);
    expect(relativeTime(date, now)).toBe("in the future");
  });
});

describe("parseRelativeTime", () => {
  it("parses '30 minutes' to 30 min in ms", () => {
    expect(parseRelativeTime("30 minutes")).toBe(30 * 60 * 1000);
  });

  it("parses '2 hours' to 2 hours in ms", () => {
    expect(parseRelativeTime("2 hours")).toBe(2 * 60 * 60 * 1000);
  });

  it("parses '1 day' to 1 day in ms", () => {
    expect(parseRelativeTime("1 day")).toBe(24 * 60 * 60 * 1000);
  });

  it("parses '1 week' to 1 week in ms", () => {
    expect(parseRelativeTime("1 week")).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("parses 'tomorrow' to a positive number", () => {
    const result = parseRelativeTime("tomorrow");
    expect(result).toBeTypeOf("number");
    expect(result!).toBeGreaterThan(0);
  });

  it("returns null for invalid input", () => {
    expect(parseRelativeTime("not a time")).toBeNull();
  });
});

describe("formatTimestamp", () => {
  it("formats a Slack ts string", () => {
    const result = formatTimestamp("1740045172.123456", "UTC");
    expect(result).toMatch(/^2025-02-20T/);
  });

  it("formats an ISO string", () => {
    const result = formatTimestamp("2026-02-20T09:32:52Z", "UTC");
    expect(result).toBe("2026-02-20T09:32:52+00:00");
  });

  it("formats a Date object", () => {
    const date = new Date("2026-02-20T09:32:52Z");
    const result = formatTimestamp(date, "UTC");
    expect(result).toBe("2026-02-20T09:32:52+00:00");
  });

  it("formats a Unix epoch in seconds", () => {
    const result = formatTimestamp(1740045172, "UTC");
    expect(result).toMatch(/^2025-02-20T/);
  });

  it("formats a Unix epoch in milliseconds", () => {
    const result = formatTimestamp(1740045172000, "UTC");
    expect(result).toMatch(/^2025-02-20T/);
  });

  it("returns empty string for null/undefined", () => {
    expect(formatTimestamp(null)).toBe("");
    expect(formatTimestamp(undefined)).toBe("");
  });

  it("returns original string for invalid input", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });
});

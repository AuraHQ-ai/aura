import { describe, expect, it } from "vitest";
import type { Memory } from "@aura/db/schema";
import { formatMemoriesForPrompt, memoryDisplayDate } from "./format-for-prompt.js";

function mem(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    type: "fact",
    content: "Alex booked the Airbnb in San Francisco on 2024-01-15",
    relatedUserIds: ["alex"],
    createdAt: new Date("2024-06-01T12:00:00.000Z"),
    validFrom: new Date("2024-06-01T12:00:00.000Z"),
    factClass: null,
    ...overrides,
  } as Memory;
}

describe("memoryDisplayDate", () => {
  it("uses createdAt when validFrom is missing", () => {
    const createdAt = new Date("2024-06-01T12:00:00.000Z");
    expect(memoryDisplayDate({ createdAt, validFrom: null }).toISOString()).toBe(
      createdAt.toISOString(),
    );
  });

  it("uses createdAt when validFrom is the same calendar day (session-time default)", () => {
    const createdAt = new Date("2024-06-01T18:00:00.000Z");
    const validFrom = new Date("2024-06-01T12:00:00.000Z");
    expect(memoryDisplayDate({ createdAt, validFrom }).toISOString()).toBe(createdAt.toISOString());
  });

  it("uses validFrom when it falls on a different calendar day (event time)", () => {
    const createdAt = new Date("2024-06-01T12:00:00.000Z");
    const validFrom = new Date("2024-01-15T00:00:00.000Z");
    expect(memoryDisplayDate({ createdAt, validFrom }).toISOString()).toBe(validFrom.toISOString());
  });
});

describe("formatMemoriesForPrompt", () => {
  const now = new Date("2024-06-15T12:00:00.000Z");

  it("pairs the ISO date with a relative phrase off createdAt by default", () => {
    const out = formatMemoriesForPrompt([mem()], now);
    expect(out).toContain("2024-06-01, about 2 weeks ago");
    expect(out).not.toContain("in the future");
  });

  it("renders relative time off validFrom when it differs from createdAt", () => {
    const out = formatMemoriesForPrompt(
      [
        mem({
          validFrom: new Date("2024-01-15T00:00:00.000Z"),
        }),
      ],
      now,
    );
    // 2024-01-15 → 2024-06-15 is five months, which relativeTime renders as
    // the month name. The ISO date is what duration questions need.
    expect(out).toContain("2024-01-15");
    expect(out).not.toContain("2024-06-01");
    expect(out).toMatch(/2024-01-15, back in January/);
  });

  it("never renders 'in the future' for a memory ingested after `now`", () => {
    const out = formatMemoriesForPrompt(
      [
        mem({
          createdAt: new Date("2024-07-01T12:00:00.000Z"),
          validFrom: new Date("2024-07-01T12:00:00.000Z"),
        }),
      ],
      now,
    );
    expect(out).not.toContain("in the future");
    // Fall back to the absolute date alone.
    expect(out).toContain("(2024-07-01)");
    expect(out).not.toContain("just now");
  });

  it("still emits type tag, content, and about-clause", () => {
    const out = formatMemoriesForPrompt([mem()], now);
    expect(out).toContain("[fact]");
    expect(out).toContain("Airbnb");
    expect(out).toContain("[about: alex]");
  });
});

describe("formatMemoriesForPrompt verify-before-asserting (#1557)", () => {
  it("flags volatile fact classes so the model does not assert them as current", () => {
    const out = formatMemoriesForPrompt(
      [mem({ content: "Aura's Claap access is broken", factClass: "access" })],
      new Date("2026-10-15T00:00:00.000Z"),
    );
    expect(out).toContain("[verify before asserting: access]");
    expect(out).toContain("Claap access is broken");
  });

  it("does not flag durable unclassified memories", () => {
    const out = formatMemoriesForPrompt(
      [mem({ content: "Joan manages the Aura codebase", factClass: null })],
      new Date("2026-10-15T00:00:00.000Z"),
    );
    expect(out).not.toContain("verify before asserting");
  });
});

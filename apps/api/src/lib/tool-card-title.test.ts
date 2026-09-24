import { describe, expect, it } from "vitest";
import {
  TOOL_CARD_LABEL_MAX_CHARS,
  resolveToolCardTitle,
  sanitizeToolCardLabel,
} from "./tool-card-title.js";

describe("sanitizeToolCardLabel", () => {
  it("trims whitespace and rejects empty/non-string values", () => {
    expect(sanitizeToolCardLabel("  pulling latest git  ")).toBe("pulling latest git");
    expect(sanitizeToolCardLabel("   ")).toBeUndefined();
    expect(sanitizeToolCardLabel("")).toBeUndefined();
    expect(sanitizeToolCardLabel(undefined)).toBeUndefined();
    expect(sanitizeToolCardLabel(12)).toBeUndefined();
  });

  it("truncates labels longer than 60 characters", () => {
    const long = "x".repeat(TOOL_CARD_LABEL_MAX_CHARS + 8);
    expect(sanitizeToolCardLabel(long)).toBe("x".repeat(TOOL_CARD_LABEL_MAX_CHARS));
  });
});

describe("resolveToolCardTitle", () => {
  const staticStatus = "Running a command in the sandbox...";
  const derivedStatus = (input: { query?: string }) =>
    input.query ? `searching the web: "${input.query}"` : "Searching the web...";

  it("prefers a per-call label over derived and static status", () => {
    expect(resolveToolCardTitle({
      input: { label: "pulling latest git", query: "ignored" },
      status: derivedStatus,
      fallback: "Working on it...",
    })).toBe("pulling latest git");

    expect(resolveToolCardTitle({
      input: { label: "  pulling latest git  " },
      status: staticStatus,
      fallback: "Working on it...",
    })).toBe("pulling latest git");
  });

  it("uses a derived status function when no label is present", () => {
    expect(resolveToolCardTitle({
      input: { query: "latest Next.js release notes" },
      status: derivedStatus,
      fallback: "Working on it...",
    })).toBe('searching the web: "latest Next.js release notes"');
  });

  it("falls back to the static status string, then the caller fallback", () => {
    expect(resolveToolCardTitle({
      input: { command: "echo ok" },
      status: staticStatus,
      fallback: "Working on it...",
    })).toBe(staticStatus);

    expect(resolveToolCardTitle({
      input: {},
      fallback: "Failed",
    })).toBe("Failed");
  });

  it("treats whitespace-only or missing labels as absent so status still wins", () => {
    expect(resolveToolCardTitle({
      input: { label: "   " },
      status: staticStatus,
      fallback: "Working on it...",
    })).toBe(staticStatus);
  });

  it("truncates an oversized label at the render layer", () => {
    const oversized = `  ${"y".repeat(TOOL_CARD_LABEL_MAX_CHARS + 12)}  `;
    expect(resolveToolCardTitle({
      input: { label: oversized },
      status: staticStatus,
      fallback: "Working on it...",
    })).toBe("y".repeat(TOOL_CARD_LABEL_MAX_CHARS));
  });
});

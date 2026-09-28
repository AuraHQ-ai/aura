import { describe, expect, it } from "vitest";
import {
  TOOL_CARD_LABEL_MAX_CHARS,
  extractLaunchId,
  formatPollerCardTitle,
  rememberLaunchLabel,
  rememberLaunchLabelFromCall,
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

  it("reuses a cached launcher label for pollers and misses to static status", () => {
    const cache = new Map<string, string>();
    expect(rememberLaunchLabelFromCall({
      cache,
      toolName: "run_command_detached",
      input: { command: "git pull", label: "pulling latest git" },
      output: { id: "abcdef12", pid: 9 },
    })).toBe(true);
    expect(rememberLaunchLabelFromCall({
      cache,
      toolName: "dispatch_cursor_agent",
      input: { label: "fixing stream-age-split bug in respond.ts" },
      output: { agent_id: "bc-123", id: "bc-123" },
    })).toBe(true);

    expect(resolveToolCardTitle({
      input: { id: "abcdef12" },
      status: "Checking command...",
      fallback: "Working on it...",
      toolName: "check_command",
      launchLabels: cache,
    })).toBe("checking job 'pulling latest git'");

    expect(resolveToolCardTitle({
      input: { agent_id: "bc-123" },
      status: "Checking agent status...",
      fallback: "Working on it...",
      toolName: "check_cursor_agent",
      launchLabels: cache,
    })).toBe("checking agent 'fixing stream-age-split bug in respond.ts'");

    expect(resolveToolCardTitle({
      input: { id: "deadbeef" },
      status: "Checking command...",
      fallback: "Working on it...",
      toolName: "check_command",
      launchLabels: cache,
    })).toBe("Checking command...");
  });

  it("does not populate the launch-label cache without an id or a label", () => {
    const cache = new Map<string, string>();
    expect(rememberLaunchLabelFromCall({
      cache,
      toolName: "run_command",
      input: { command: "echo ok", label: "echoing ok" },
      output: { ok: true, exit_code: 0 },
    })).toBe(false);
    expect(rememberLaunchLabelFromCall({
      cache,
      toolName: "run_command_detached",
      input: { command: "sleep 1" },
      output: { id: "abcdef12" },
    })).toBe(false);
    expect(rememberLaunchLabelFromCall({
      cache,
      toolName: "web_search",
      input: { query: "x", label: "should not cache" },
      output: { id: "not-a-launcher" },
    })).toBe(false);
    expect(cache.size).toBe(0);
  });

  it("populates the cache from a timed-out run_command result id", () => {
    const cache = new Map<string, string>();
    expect(rememberLaunchLabelFromCall({
      cache,
      toolName: "run_command",
      input: { command: "sleep 300", label: "  pulling latest git  " },
      output: { ok: false, id: "abcdef12", pid: 44, error: "timed out" },
    })).toBe(true);
    expect(cache.get("abcdef12")).toBe("pulling latest git");
    expect(extractLaunchId({ agent_id: "bc-9" })).toBe("bc-9");
    expect(rememberLaunchLabel(cache, "bc-9", "fixing stream-age-split")).toBe(true);
    expect(formatPollerCardTitle("agent", "fixing stream-age-split")).toBe(
      "checking agent 'fixing stream-age-split'",
    );
  });
});

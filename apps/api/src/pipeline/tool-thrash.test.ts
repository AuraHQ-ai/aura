import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONSECUTIVE_TOOL_ERROR_LIMIT,
  DEFAULT_MAX_TOOL_CALLS_PER_TURN,
  detectToolThrashFromSteps,
  isFailedToolOutput,
  resolveToolThrashLimits,
  ToolThrashBreaker,
  ToolThrashError,
} from "./tool-thrash.js";

describe("ToolThrashBreaker (issue #1524)", () => {
  afterEach(() => {
    delete process.env.TOOL_THRASH_CONSECUTIVE_ERROR_LIMIT;
    delete process.env.TOOL_THRASH_MAX_TOOL_CALLS;
  });

  it("aborts on the Nth consecutive tool execution error", () => {
    const breaker = new ToolThrashBreaker({
      consecutiveErrorLimit: 5,
      maxToolCalls: 40,
    });
    for (let i = 0; i < 4; i++) {
      expect(breaker.recordCall(`tool_${i}`)).toBeNull();
      expect(breaker.recordResult(false, `tool_${i}`)).toBeNull();
    }
    expect(breaker.recordCall("tool_4")).toBeNull();
    const trip = breaker.recordResult(false, "tool_4");
    expect(trip).toMatchObject({
      reason: "consecutive_errors",
      consecutiveErrors: 5,
      callCount: 5,
      lastToolName: "tool_4",
    });
  });

  it("resets the error streak after a successful tool result", () => {
    const breaker = new ToolThrashBreaker({
      consecutiveErrorLimit: 5,
      maxToolCalls: 40,
    });
    for (let i = 0; i < 4; i++) {
      breaker.recordCall("fail");
      breaker.recordResult(false, "fail");
    }
    breaker.recordCall("ok");
    expect(breaker.recordResult(true, "ok")).toBeNull();
    for (let i = 0; i < 4; i++) {
      breaker.recordCall("fail");
      expect(breaker.recordResult(false, "fail")).toBeNull();
    }
    expect(breaker.trip).toBeNull();
  });

  it("aborts when the per-turn tool-call cap is exceeded", () => {
    const breaker = new ToolThrashBreaker({
      consecutiveErrorLimit: 5,
      maxToolCalls: 40,
    });
    for (let i = 0; i < 40; i++) {
      expect(breaker.recordCall(`ok_${i}`)).toBeNull();
      expect(breaker.recordResult(true, `ok_${i}`)).toBeNull();
    }
    const trip = breaker.recordCall("one_too_many");
    expect(trip).toMatchObject({
      reason: "max_tool_calls",
      callCount: 41,
    });
  });

  it("reads configurable limits from env", () => {
    process.env.TOOL_THRASH_CONSECUTIVE_ERROR_LIMIT = "3";
    process.env.TOOL_THRASH_MAX_TOOL_CALLS = "7";
    expect(resolveToolThrashLimits()).toEqual({
      consecutiveErrorLimit: 3,
      maxToolCalls: 7,
    });
  });

  it("falls back to defaults for missing or invalid env", () => {
    process.env.TOOL_THRASH_CONSECUTIVE_ERROR_LIMIT = "nope";
    process.env.TOOL_THRASH_MAX_TOOL_CALLS = "0";
    expect(resolveToolThrashLimits()).toEqual({
      consecutiveErrorLimit: DEFAULT_CONSECUTIVE_TOOL_ERROR_LIMIT,
      maxToolCalls: DEFAULT_MAX_TOOL_CALLS_PER_TURN,
    });
  });
});

describe("detectToolThrashFromSteps (issue #1524)", () => {
  it("trips on a replayed streak of failed toolResults", () => {
    const steps = Array.from({ length: 5 }, (_, i) => ({
      text: "",
      toolCalls: [{ toolName: "archive_emails", toolCallId: `c${i}` }],
      toolResults: [{
        toolName: "archive_emails",
        toolCallId: `c${i}`,
        output: { ok: false, error: "nope" },
      }],
    }));
    expect(detectToolThrashFromSteps(steps)).toMatchObject({
      reason: "consecutive_errors",
      consecutiveErrors: 5,
    });
  });

  it("does not trip when intervening successes break the streak", () => {
    const fail = (id: string) => ({
      text: "",
      toolCalls: [{ toolName: "create_channel", toolCallId: id }],
      toolResults: [{ toolName: "create_channel", toolCallId: id, output: { ok: false } }],
    });
    const ok = {
      text: "",
      toolCalls: [{ toolName: "search_messages", toolCallId: "ok" }],
      toolResults: [{ toolName: "search_messages", toolCallId: "ok", output: { ok: true } }],
    };
    expect(detectToolThrashFromSteps([fail("1"), fail("2"), ok, fail("3"), fail("4")])).toBeNull();
  });

  it("trips when replayed history already exceeded the call cap", () => {
    const steps = Array.from({ length: 41 }, (_, i) => ({
      text: "",
      toolCalls: [{ toolName: "read_canvas", toolCallId: `c${i}` }],
      toolResults: [{ toolName: "read_canvas", toolCallId: `c${i}`, output: { ok: true } }],
    }));
    expect(detectToolThrashFromSteps(steps)).toMatchObject({
      reason: "max_tool_calls",
      callCount: 41,
    });
  });
});

describe("isFailedToolOutput / ToolThrashError", () => {
  it("treats {ok:false} and {error} as failures", () => {
    expect(isFailedToolOutput({ ok: false })).toBe(true);
    expect(isFailedToolOutput({ error: "boom" })).toBe(true);
    expect(isFailedToolOutput({ ok: true })).toBe(false);
    expect(isFailedToolOutput("fine")).toBe(false);
  });

  it("names the error ToolThrashError", () => {
    const err = new ToolThrashError({
      reason: "consecutive_errors",
      callCount: 5,
      consecutiveErrors: 5,
      recentToolNames: ["archive_emails"],
      limits: { consecutiveErrorLimit: 5, maxToolCalls: 40 },
    });
    expect(err.name).toBe("ToolThrashError");
    expect(err.message).toContain("consecutive tool execution errors");
  });
});

import { describe, it, expect, vi } from "vitest";
import { ALERT_BLOCK_KEY, buildAlertBlock, createAlertTools } from "./alert.js";

vi.mock("../db/client.js", () => ({
  db: {},
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("buildAlertBlock", () => {
  it("builds an alert block with mrkdwn text and a severity level", () => {
    expect(buildAlertBlock("*3 jobs failed* — email-delivery cluster degraded", "error")).toEqual({
      type: "alert",
      text: {
        type: "mrkdwn",
        text: "*3 jobs failed* — email-delivery cluster degraded",
      },
      level: "error",
    });
  });

  it("omits the level field when not provided (Slack defaults to 'default')", () => {
    const block = buildAlertBlock("Heads up");
    expect(block).toEqual({
      type: "alert",
      text: { type: "mrkdwn", text: "Heads up" },
    });
    expect("level" in block).toBe(false);
  });
});

describe("raise_alert inline mode", () => {
  it("returns a native alert block under the sentinel key", async () => {
    const tools = createAlertTools();
    const result = await (tools.raise_alert as any).execute({
      text: "Scam listing escalation: act now",
      level: "warning",
    });

    expect(result.ok).toBe(true);
    expect(result[ALERT_BLOCK_KEY]).toEqual({
      type: "alert",
      text: { type: "mrkdwn", text: "Scam listing escalation: act now" },
      level: "warning",
    });
  });

  it("trims surrounding whitespace from the alert text", async () => {
    const tools = createAlertTools();
    const result = await (tools.raise_alert as any).execute({
      text: "  Stale job killed  ",
      level: "info",
    });

    expect(result.ok).toBe(true);
    expect(result[ALERT_BLOCK_KEY].text.text).toBe("Stale job killed");
  });

  it("rejects whitespace-only text", async () => {
    const tools = createAlertTools();
    const result = await (tools.raise_alert as any).execute({
      text: "   ",
      level: "error",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
  });

  it("rejects text longer than Slack's 200-character limit", async () => {
    const tools = createAlertTools();
    const result = await (tools.raise_alert as any).execute({
      text: "x".repeat(201),
      level: "error",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("max is 200");
  });
});

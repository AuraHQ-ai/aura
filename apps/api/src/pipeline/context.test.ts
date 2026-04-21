import { describe, expect, it } from "vitest";
import { isChannelGatedOut } from "./context.js";

describe("isChannelGatedOut", () => {
  it("gates channel messages without explicit mention when channel is configured", () => {
    const result = isChannelGatedOut(
      { isDm: false, isMentioned: false, channelId: "Cbugs" },
      new Set(["Cbugs"]),
    );

    expect(result).toBe(true);
  });

  it("allows messages with explicit mention in a gated channel", () => {
    const result = isChannelGatedOut(
      { isDm: false, isMentioned: true, channelId: "Cbugs" },
      new Set(["Cbugs"]),
    );

    expect(result).toBe(false);
  });

  it("does not gate when gated_channels is empty", () => {
    const result = isChannelGatedOut(
      { isDm: false, isMentioned: false, channelId: "Cbugs" },
      new Set(),
    );

    expect(result).toBe(false);
  });

  it("bypasses gate for DMs regardless of gated channel config", () => {
    const result = isChannelGatedOut(
      { isDm: true, isMentioned: false, channelId: "Cbugs" },
      new Set(["Cbugs"]),
    );

    expect(result).toBe(false);
  });
});

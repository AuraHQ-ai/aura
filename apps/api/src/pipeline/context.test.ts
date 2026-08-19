import { beforeAll, describe, expect, it, vi } from "vitest";

let isChannelGatedOut: (
  context: { isDm: boolean; isMentioned: boolean; channelId: string },
  gatedChannels: Set<string>,
) => boolean;

beforeAll(async () => {
  vi.mock("../lib/ai.js", () => ({
    getFastModel: vi.fn(),
    withCacheControl: vi.fn(),
  }));
  vi.mock("../tools/slack.js", () => ({
    resolveChannelById: vi.fn(),
  }));
  ({ isChannelGatedOut } = await import("./context.js"));
});

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

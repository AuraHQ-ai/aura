import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  setStatusUnsupportedChannels,
  trySetAssistantThreadStatus,
} from "./slack-status.js";

function createClient(error: unknown) {
  return {
    assistant: {
      threads: {
        setStatus: vi.fn().mockRejectedValue(error),
      },
    },
  } as any;
}

describe("trySetAssistantThreadStatus", () => {
  beforeEach(() => {
    setStatusUnsupportedChannels.clear();
    vi.clearAllMocks();
  });

  it("swallows setStatus failures so callers keep running", async () => {
    const client = createClient(Object.assign(new Error("rate limited"), {
      data: { error: "rate_limited" },
    }));

    await expect(trySetAssistantThreadStatus({
      client,
      channelId: "C123",
      threadTs: "1710000000.000000",
      status: "Working on it...",
    })).resolves.toBeUndefined();
  });

  it("blacklists channel_not_found errors", async () => {
    const client = createClient(Object.assign(new Error("channel missing"), {
      data: { error: "channel_not_found" },
    }));

    await trySetAssistantThreadStatus({
      client,
      channelId: "C404",
      threadTs: "1710000000.000000",
      status: "Working on it...",
    });

    expect(setStatusUnsupportedChannels.has("C404")).toBe(true);
  });

  it("blacklists persistent scope errors", async () => {
    const client = createClient(Object.assign(new Error("missing scope"), {
      data: { error: "missing_scope" },
    }));

    await trySetAssistantThreadStatus({
      client,
      channelId: "C_SCOPE",
      threadTs: "1710000000.000000",
      status: "Working on it...",
    });

    expect(setStatusUnsupportedChannels.has("C_SCOPE")).toBe(true);
  });

  it("does not blacklist transient Slack or network errors", async () => {
    const transientErrors = [
      Object.assign(new Error("rate limited"), { data: { error: "rate_limited" } }),
      Object.assign(new Error("internal error"), { data: { error: "internal_error" } }),
      Object.assign(new Error("bad gateway"), { statusCode: 502 }),
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    ];

    for (const [index, error] of transientErrors.entries()) {
      await trySetAssistantThreadStatus({
        client: createClient(error),
        channelId: `C_TRANSIENT_${index}`,
        threadTs: "1710000000.000000",
        status: "Working on it...",
      });
    }

    expect([...setStatusUnsupportedChannels]).toEqual([]);
  });
});

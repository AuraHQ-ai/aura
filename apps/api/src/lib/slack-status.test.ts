import type { WebClient } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loggerWarnMock: vi.fn(),
}));

vi.mock("./logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.loggerWarnMock,
    error: vi.fn(),
  },
}));

import {
  setAssistantThreadTitle,
  setStatusUnsupportedChannels,
  trySetAssistantThreadStatus,
} from "./slack-status.js";

function makeClient() {
  const client = {
    apiCall: vi.fn(async () => ({ ok: true })),
  };
  return { client, asWebClient: client as unknown as WebClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  setStatusUnsupportedChannels.clear();
});

describe("trySetAssistantThreadStatus", () => {
  it("calls raw apiCall agents.sessions.setStatus with channel/thread/status", async () => {
    const { client, asWebClient } = makeClient();

    await trySetAssistantThreadStatus({
      client: asWebClient,
      channelId: "D123",
      threadTs: "1724264405.531769",
      status: "is thinking...",
    });

    expect(client.apiCall).toHaveBeenCalledExactlyOnceWith(
      "agents.sessions.setStatus",
      {
        channel_id: "D123",
        thread_ts: "1724264405.531769",
        status: "is thinking...",
      },
    );
  });

  it("skips when threadTs is missing", async () => {
    const { client, asWebClient } = makeClient();

    await trySetAssistantThreadStatus({
      client: asWebClient,
      channelId: "D123",
      status: "working",
    });

    expect(client.apiCall).not.toHaveBeenCalled();
  });

  it("soft-fails and disables the channel on error", async () => {
    const { client, asWebClient } = makeClient();
    client.apiCall.mockRejectedValueOnce(
      new Error("An API error occurred: channel_not_found"),
    );

    await expect(
      trySetAssistantThreadStatus({
        client: asWebClient,
        channelId: "DFAIL",
        threadTs: "1.2",
        status: "working",
      }),
    ).resolves.toBeUndefined();

    expect(setStatusUnsupportedChannels.has("DFAIL")).toBe(true);
    expect(mocks.loggerWarnMock).toHaveBeenCalledExactlyOnceWith(
      "agents.sessions.setStatus failed; disabling for channel",
      expect.objectContaining({ channelId: "DFAIL" }),
    );

    // Subsequent calls in the disabled channel are skipped entirely.
    await trySetAssistantThreadStatus({
      client: asWebClient,
      channelId: "DFAIL",
      threadTs: "1.3",
      status: "still working",
    });
    expect(client.apiCall).toHaveBeenCalledTimes(1);
  });
});

describe("setAssistantThreadTitle", () => {
  it("calls raw apiCall agents.sessions.rename with `title` field", async () => {
    const { client, asWebClient } = makeClient();

    await setAssistantThreadTitle({
      client: asWebClient,
      channelId: "D123",
      threadTs: "1786543.345678",
      title: "Holidays this year",
    });

    expect(client.apiCall).toHaveBeenCalledExactlyOnceWith(
      "agents.sessions.rename",
      {
        channel_id: "D123",
        thread_ts: "1786543.345678",
        title: "Holidays this year",
      },
    );
  });

  it("propagates errors to the caller (call sites own the soft-fail catch)", async () => {
    const { client, asWebClient } = makeClient();
    client.apiCall.mockRejectedValueOnce(new Error("boom"));

    await expect(
      setAssistantThreadTitle({
        client: asWebClient,
        channelId: "D123",
        threadTs: "1.2",
        title: "t",
      }),
    ).rejects.toThrow("boom");
  });
});

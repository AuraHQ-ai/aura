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
    assistant: {
      threads: {
        setStatus: vi.fn(async () => ({ ok: true })),
        setTitle: vi.fn(async () => ({ ok: true })),
      },
    },
  };
  return { client, asWebClient: client as unknown as WebClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  setStatusUnsupportedChannels.clear();
  delete process.env.SLACK_AGENT_VIEW;
});

describe("trySetAssistantThreadStatus", () => {
  it("flag off (unset): calls assistant.threads.setStatus, never agents.sessions", async () => {
    const { client, asWebClient } = makeClient();

    await trySetAssistantThreadStatus({
      client: asWebClient,
      channelId: "D123",
      threadTs: "1724264405.531769",
      status: "is thinking...",
      loadingMessages: ["one", "two"],
    });

    expect(client.assistant.threads.setStatus).toHaveBeenCalledExactlyOnceWith({
      channel_id: "D123",
      thread_ts: "1724264405.531769",
      status: "is thinking...",
      loading_messages: ["one", "two"],
    });
    expect(client.apiCall).not.toHaveBeenCalled();
  });

  it('flag explicitly "off": behaves identically to unset', async () => {
    process.env.SLACK_AGENT_VIEW = "off";
    const { client, asWebClient } = makeClient();

    await trySetAssistantThreadStatus({
      client: asWebClient,
      channelId: "D123",
      threadTs: "1.2",
      status: "working",
    });

    expect(client.assistant.threads.setStatus).toHaveBeenCalledExactlyOnceWith({
      channel_id: "D123",
      thread_ts: "1.2",
      status: "working",
    });
    expect(client.apiCall).not.toHaveBeenCalled();
  });

  it("flag on: calls raw apiCall agents.sessions.setStatus, never assistant.threads", async () => {
    process.env.SLACK_AGENT_VIEW = "on";
    const { client, asWebClient } = makeClient();

    await trySetAssistantThreadStatus({
      client: asWebClient,
      channelId: "D123",
      threadTs: "1724264405.531769",
      status: "is thinking...",
      // loading_messages is not a documented agents.sessions.setStatus
      // argument — it must NOT be forwarded on the agent-view path.
      loadingMessages: ["one", "two"],
    });

    expect(client.apiCall).toHaveBeenCalledExactlyOnceWith(
      "agents.sessions.setStatus",
      {
        channel_id: "D123",
        thread_ts: "1724264405.531769",
        status: "is thinking...",
      },
    );
    expect(client.assistant.threads.setStatus).not.toHaveBeenCalled();
  });

  it("skips when threadTs is missing (both flag states)", async () => {
    for (const flag of [undefined, "on"]) {
      if (flag) process.env.SLACK_AGENT_VIEW = flag;
      else delete process.env.SLACK_AGENT_VIEW;
      const { client, asWebClient } = makeClient();

      await trySetAssistantThreadStatus({
        client: asWebClient,
        channelId: "D123",
        status: "working",
      });

      expect(client.assistant.threads.setStatus).not.toHaveBeenCalled();
      expect(client.apiCall).not.toHaveBeenCalled();
    }
  });

  it("flag off: soft-fails and disables the channel on error", async () => {
    const { client, asWebClient } = makeClient();
    client.assistant.threads.setStatus.mockRejectedValueOnce(
      new Error("An API error occurred: method_not_supported_for_channel_type"),
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
      "assistant.threads.setStatus failed; disabling for channel",
      expect.objectContaining({ channelId: "DFAIL" }),
    );

    // Subsequent calls in the disabled channel are skipped entirely.
    await trySetAssistantThreadStatus({
      client: asWebClient,
      channelId: "DFAIL",
      threadTs: "1.3",
      status: "still working",
    });
    expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
  });

  it("flag on: soft-fails and disables the channel on error", async () => {
    process.env.SLACK_AGENT_VIEW = "on";
    const { client, asWebClient } = makeClient();
    client.apiCall.mockRejectedValueOnce(
      new Error("An API error occurred: channel_not_found"),
    );

    await expect(
      trySetAssistantThreadStatus({
        client: asWebClient,
        channelId: "DFAIL2",
        threadTs: "1.2",
        status: "working",
      }),
    ).resolves.toBeUndefined();

    expect(setStatusUnsupportedChannels.has("DFAIL2")).toBe(true);
    expect(mocks.loggerWarnMock).toHaveBeenCalledExactlyOnceWith(
      "agents.sessions.setStatus failed; disabling for channel",
      expect.objectContaining({ channelId: "DFAIL2" }),
    );

    await trySetAssistantThreadStatus({
      client: asWebClient,
      channelId: "DFAIL2",
      threadTs: "1.3",
      status: "still working",
    });
    expect(client.apiCall).toHaveBeenCalledTimes(1);
  });
});

describe("setAssistantThreadTitle", () => {
  it("flag off: calls assistant.threads.setTitle, never agents.sessions", async () => {
    const { client, asWebClient } = makeClient();

    await setAssistantThreadTitle({
      client: asWebClient,
      channelId: "D123",
      threadTs: "1786543.345678",
      title: "Holidays this year",
    });

    expect(client.assistant.threads.setTitle).toHaveBeenCalledExactlyOnceWith({
      channel_id: "D123",
      thread_ts: "1786543.345678",
      title: "Holidays this year",
    });
    expect(client.apiCall).not.toHaveBeenCalled();
  });

  it("flag on: calls raw apiCall agents.sessions.rename with `title` field", async () => {
    process.env.SLACK_AGENT_VIEW = "on";
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
    expect(client.assistant.threads.setTitle).not.toHaveBeenCalled();
  });

  it("propagates errors to the caller (call sites own the soft-fail catch)", async () => {
    process.env.SLACK_AGENT_VIEW = "on";
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

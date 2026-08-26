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
  trySetAgentSessionStatus,
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

describe("trySetAgentSessionStatus", () => {
  it("calls raw apiCall agents.sessions.setStatus with an enum status", async () => {
    const { client, asWebClient } = makeClient();

    await trySetAgentSessionStatus({
      client: asWebClient,
      channelId: "D123",
      threadTs: "1724264405.531769",
      status: "processing",
    });

    expect(client.apiCall).toHaveBeenCalledExactlyOnceWith(
      "agents.sessions.setStatus",
      {
        channel_id: "D123",
        thread_ts: "1724264405.531769",
        status: "processing",
      },
    );
  });

  it("accepts every value of the agent_view status enum", async () => {
    const { client, asWebClient } = makeClient();

    for (const status of ["suspended", "processing", "active", "closed"] as const) {
      await trySetAgentSessionStatus({
        client: asWebClient,
        channelId: "D123",
        threadTs: "1.2",
        status,
      });
    }

    expect(client.apiCall).toHaveBeenCalledTimes(4);
    expect(client.apiCall).toHaveBeenLastCalledWith("agents.sessions.setStatus", {
      channel_id: "D123",
      thread_ts: "1.2",
      status: "closed",
    });
  });

  it("rejects free-text statuses at compile time (agent_view enum contract)", async () => {
    const { client, asWebClient } = makeClient();

    await trySetAgentSessionStatus({
      client: asWebClient,
      channelId: "D123",
      threadTs: "1.2",
      // @ts-expect-error — free-text statuses were an assistant_view concept;
      // agents.sessions.setStatus rejects them with invalid_arguments.
      status: "Thinking...",
    });
  });

  it("no longer accepts loadingMessages (assistant-only concept, deleted from the interface)", async () => {
    const { client, asWebClient } = makeClient();

    await trySetAgentSessionStatus({
      client: asWebClient,
      channelId: "D123",
      threadTs: "1.2",
      status: "processing",
      // @ts-expect-error — loading_messages does not exist under agent_view
      // and must not be forwardable through this helper.
      loadingMessages: ["one", "two"],
    });

    // Even if forced past the compiler, nothing beyond the documented
    // payload fields is forwarded to the API.
    expect(client.apiCall).toHaveBeenCalledExactlyOnceWith(
      "agents.sessions.setStatus",
      {
        channel_id: "D123",
        thread_ts: "1.2",
        status: "processing",
      },
    );
  });

  it("skips when threadTs is missing", async () => {
    const { client, asWebClient } = makeClient();

    await trySetAgentSessionStatus({
      client: asWebClient,
      channelId: "D123",
      status: "processing",
    });

    expect(client.apiCall).not.toHaveBeenCalled();
  });

  it("soft-fails and disables the channel on error", async () => {
    const { client, asWebClient } = makeClient();
    client.apiCall.mockRejectedValueOnce(
      new Error("An API error occurred: invalid_arguments"),
    );

    await expect(
      trySetAgentSessionStatus({
        client: asWebClient,
        channelId: "DFAIL",
        threadTs: "1.2",
        status: "processing",
      }),
    ).resolves.toBeUndefined();

    expect(setStatusUnsupportedChannels.has("DFAIL")).toBe(true);
    expect(mocks.loggerWarnMock).toHaveBeenCalledExactlyOnceWith(
      "agents.sessions.setStatus failed; disabling for channel",
      expect.objectContaining({ channelId: "DFAIL" }),
    );

    // Subsequent calls in the disabled channel are skipped entirely.
    await trySetAgentSessionStatus({
      client: asWebClient,
      channelId: "DFAIL",
      threadTs: "1.3",
      status: "active",
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

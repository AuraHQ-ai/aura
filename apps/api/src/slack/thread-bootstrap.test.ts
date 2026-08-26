import type { WebClient } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapAssistantThread } from "./thread-bootstrap.js";

function makeClient() {
  const client = {
    apiCall: vi.fn(async () => ({ ok: true })),
    assistant: {
      threads: {
        setSuggestedPrompts: vi.fn(async () => ({ ok: true })),
      },
    },
  };
  return { client, asWebClient: client as unknown as WebClient };
}

beforeEach(() => {
  delete process.env.SLACK_AGENT_VIEW;
});

describe("bootstrapAssistantThread", () => {
  it("flag off: sets suggested prompts with today's exact payload", async () => {
    const { client, asWebClient } = makeClient();

    await bootstrapAssistantThread({
      client: asWebClient,
      channelId: "D123",
      threadTs: "1724264405.531769",
    });

    expect(
      client.assistant.threads.setSuggestedPrompts,
    ).toHaveBeenCalledExactlyOnceWith({
      channel_id: "D123",
      thread_ts: "1724264405.531769",
      title: "How can I help?",
      prompts: [
        { title: "Catch me up", message: "What happened in my channels while I was away?" },
        { title: "Run a query", message: "Show me this week's key metrics from BigQuery" },
        { title: "Search Slack", message: "Find recent messages about..." },
        { title: "What do you know?", message: "What do you know about me?" },
      ],
    });
    expect(client.apiCall).not.toHaveBeenCalled();
  });

  it("flag off: no-ops when channelId or threadTs is missing", async () => {
    const { client, asWebClient } = makeClient();

    await bootstrapAssistantThread({ client: asWebClient, threadTs: "1.2" });
    await bootstrapAssistantThread({ client: asWebClient, channelId: "D123" });

    expect(client.assistant.threads.setSuggestedPrompts).not.toHaveBeenCalled();
    expect(client.apiCall).not.toHaveBeenCalled();
  });

  it("flag on: never calls setSuggestedPrompts (removed in agent view) and makes no API calls", async () => {
    process.env.SLACK_AGENT_VIEW = "on";
    const { client, asWebClient } = makeClient();

    await expect(
      bootstrapAssistantThread({
        client: asWebClient,
        channelId: "D123",
        threadTs: "1724264405.531769",
      }),
    ).resolves.toBeUndefined();

    // Suggested prompts are static dashboard config under agent_view — the
    // runtime must not attempt the removed assistant.threads method.
    expect(client.assistant.threads.setSuggestedPrompts).not.toHaveBeenCalled();
    expect(client.apiCall).not.toHaveBeenCalled();
  });

  it("flag on: no-ops without a thread_ts (app_home_opened carries none)", async () => {
    process.env.SLACK_AGENT_VIEW = "on";
    const { client, asWebClient } = makeClient();

    await bootstrapAssistantThread({ client: asWebClient, channelId: "D123" });

    expect(client.assistant.threads.setSuggestedPrompts).not.toHaveBeenCalled();
    expect(client.apiCall).not.toHaveBeenCalled();
  });
});

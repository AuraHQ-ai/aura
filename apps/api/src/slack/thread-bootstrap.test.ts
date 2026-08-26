import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { bootstrapAssistantThread } from "./thread-bootstrap.js";

function makeClient() {
  const client = {
    apiCall: vi.fn(async () => ({ ok: true })),
  };
  return { client, asWebClient: client as unknown as WebClient };
}

describe("bootstrapAssistantThread", () => {
  it("makes no API calls (suggested prompts are static dashboard config under agent view)", async () => {
    const { client, asWebClient } = makeClient();

    await expect(
      bootstrapAssistantThread({
        client: asWebClient,
        channelId: "D123",
      }),
    ).resolves.toBeUndefined();

    expect(client.apiCall).not.toHaveBeenCalled();
  });

  it("no-ops when channelId is missing", async () => {
    const { client, asWebClient } = makeClient();

    await expect(
      bootstrapAssistantThread({ client: asWebClient }),
    ).resolves.toBeUndefined();

    expect(client.apiCall).not.toHaveBeenCalled();
  });
});

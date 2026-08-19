import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "../lib/logger.js";
import { fetchConversationContext } from "./slack-context.js";

describe("fetchConversationContext", () => {
  it("logs Slack history failures with channel id and type", async () => {
    const client = {
      conversations: {
        history: vi.fn().mockRejectedValue({
          message: "missing_scope",
          data: { error: "missing_scope" },
        }),
      },
    } as any;

    const result = await fetchConversationContext(
      client,
      "C0AGDP9STND",
      "UAURA",
      undefined,
      "mpim",
    );

    expect(result.recentMessages).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to fetch Slack conversation history",
      expect.objectContaining({
        channelId: "C0AGDP9STND",
        channelType: "mpim",
        slackErrorCode: "missing_scope",
      }),
    );
  });
});

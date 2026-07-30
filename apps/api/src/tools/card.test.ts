import { describe, it, expect, vi } from "vitest";
import { CARD_BLOCK_KEY, buildCardBlock, createCardTools } from "./card.js";

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

describe("buildCardBlock", () => {
  it("builds one card block per section with mrkdwn title and body", () => {
    const blocks = buildCardBlock([
      { title: "WINS", text: "Shipped the digest revamp." },
      { title: "NOTED", text: "SEO W30 traffic flat week-over-week." },
      { title: "FOLLOW-UPS", text: "Ping Guillaume about the scam listing." },
    ]);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({
      type: "card",
      title: { type: "mrkdwn", text: "WINS" },
      body: { type: "mrkdwn", text: "Shipped the digest revamp." },
    });
    expect(blocks.map((b) => b.type)).toEqual(["card", "card", "card"]);
  });
});

describe("draw_cards inline mode", () => {
  it("returns an array of card blocks under the sentinel key", async () => {
    const tools = createCardTools();
    const result = await (tools.draw_cards as any).execute({
      sections: [
        { title: "WINS", text: "Two PRs merged." },
        { title: "FOLLOW-UPS", text: "Check the gap-issue sync tomorrow." },
      ],
    });

    expect(result.ok).toBe(true);
    expect(Array.isArray(result[CARD_BLOCK_KEY])).toBe(true);
    expect(result[CARD_BLOCK_KEY]).toHaveLength(2);
    expect(result[CARD_BLOCK_KEY][0]).toEqual({
      type: "card",
      title: { type: "mrkdwn", text: "WINS" },
      body: { type: "mrkdwn", text: "Two PRs merged." },
    });
    expect(result[CARD_BLOCK_KEY][1].title.text).toBe("FOLLOW-UPS");
  });

  it("rejects an empty section list", async () => {
    const tools = createCardTools();
    const result = await (tools.draw_cards as any).execute({ sections: [] });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("at least one section");
  });

  it("rejects more than 10 sections", async () => {
    const tools = createCardTools();
    const result = await (tools.draw_cards as any).execute({
      sections: Array.from({ length: 11 }, (_, i) => ({
        title: `Section ${i}`,
        text: "Body",
      })),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Max 10 sections");
  });

  it("rejects titles over Slack's 150-character limit", async () => {
    const tools = createCardTools();
    const result = await (tools.draw_cards as any).execute({
      sections: [{ title: "t".repeat(151), text: "Body" }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("max is 150");
  });

  it("rejects body text over Slack's 200-character limit", async () => {
    const tools = createCardTools();
    const result = await (tools.draw_cards as any).execute({
      sections: [{ title: "NOTED", text: "b".repeat(201) }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("max is 200");
  });

  it("rejects sections with empty titles or bodies", async () => {
    const tools = createCardTools();
    const emptyTitle = await (tools.draw_cards as any).execute({
      sections: [{ title: "  ", text: "Body" }],
    });
    expect(emptyTitle.ok).toBe(false);
    expect(emptyTitle.error).toContain("title is required");

    const emptyBody = await (tools.draw_cards as any).execute({
      sections: [{ title: "WINS", text: "  " }],
    });
    expect(emptyBody.ok).toBe(false);
    expect(emptyBody.error).toContain("text is required");
  });
});

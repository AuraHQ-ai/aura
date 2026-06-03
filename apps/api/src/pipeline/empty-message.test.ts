import { describe, expect, it } from "vitest";

import type { ConversationContext } from "./slack-context.js";
import {
  BARE_MENTION_WITH_CONTEXT_PROMPT,
  hasSurroundingConversationContext,
  shouldGreetAndBailForEmptyMessage,
} from "./empty-message.js";

function conversation(
  overrides: Partial<ConversationContext> = {},
): ConversationContext {
  return {
    thread: null,
    recentMessages: [],
    isAuraParticipant: false,
    isAuraThread: false,
    auraRecentlyActive: false,
    ...overrides,
  };
}

describe("empty-message pipeline guard", () => {
  it("falls through for a bare mention when surrounding context exists", () => {
    const ctx = { isMentioned: true, messageTs: "200.000" };
    const conv = conversation({
      recentMessages: [
        {
          user: "U_founder",
          displayName: "Joan",
          text: "Aura, can you look at the launch checklist?",
          ts: "199.000",
          isBot: false,
        },
        {
          user: "U_requester",
          displayName: "Jonas",
          text: "<@UAURA>",
          ts: "200.000",
          isBot: false,
        },
      ],
    });

    expect(hasSurroundingConversationContext(conv, ctx.messageTs)).toBe(true);
    expect(shouldGreetAndBailForEmptyMessage(ctx, conv)).toBe(false);
    expect(BARE_MENTION_WITH_CONTEXT_PROMPT).toContain("latest unanswered message");
  });

  it("greets only when there is no mention or no surrounding context", () => {
    const conv = conversation({
      recentMessages: [
        {
          user: "U_requester",
          displayName: "Jonas",
          text: "<@UAURA>",
          ts: "200.000",
          isBot: false,
        },
      ],
    });

    expect(
      shouldGreetAndBailForEmptyMessage(
        { isMentioned: true, messageTs: "200.000" },
        conv,
      ),
    ).toBe(true);
    expect(
      shouldGreetAndBailForEmptyMessage(
        { isMentioned: false, messageTs: "200.000" },
        conversation({
          recentMessages: [
            {
              user: "U_founder",
              displayName: "Joan",
              text: "Is Aura there?",
              ts: "199.000",
              isBot: false,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("counts thread context around a bare mention as actionable context", () => {
    const conv = conversation({
      thread: [
        {
          user: "U_founder",
          displayName: "Joan",
          text: "What changed in the deployment?",
          ts: "100.000",
          isBot: false,
        },
        {
          user: "U_requester",
          displayName: "Jonas",
          text: "<@UAURA>",
          ts: "101.000",
          isBot: false,
        },
      ],
    });

    expect(
      shouldGreetAndBailForEmptyMessage(
        { isMentioned: true, messageTs: "101.000" },
        conv,
      ),
    ).toBe(false);
  });
});

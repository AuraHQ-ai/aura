import { describe, it, expect } from "vitest";
import { buildMessageContext, resolveChannelType } from "../pipeline/context.js";
import type { SlackMessageEvent, SlackAppMentionEvent } from "../pipeline/context.js";

const BOT_USER_ID = "U_BOT";

describe("resolveChannelType", () => {
  it('returns "dm" when channel_type is "im"', () => {
    const event = { type: "message", channel: "C1", ts: "1", channel_type: "im" } as SlackMessageEvent;
    expect(resolveChannelType(event)).toBe("dm");
  });

  it('returns "private_channel" when channel_type is "group"', () => {
    const event = { type: "message", channel: "C1", ts: "1", channel_type: "group" } as SlackMessageEvent;
    expect(resolveChannelType(event)).toBe("private_channel");
  });

  it('returns "private_channel" when channel_type is "mpim"', () => {
    const event = { type: "message", channel: "C1", ts: "1", channel_type: "mpim" } as SlackMessageEvent;
    expect(resolveChannelType(event)).toBe("private_channel");
  });

  it('returns "slack_list_item" when channel_type is "slack_list_item"', () => {
    const event = { type: "message", channel: "C1", ts: "1", channel_type: "slack_list_item" } as SlackMessageEvent;
    expect(resolveChannelType(event)).toBe("slack_list_item");
  });

  it('returns "public_channel" when channel_type is "channel"', () => {
    const event = { type: "message", channel: "C1", ts: "1", channel_type: "channel" } as SlackMessageEvent;
    expect(resolveChannelType(event)).toBe("public_channel");
  });

  it('returns "public_channel" when channel_type is missing', () => {
    const event = { type: "app_mention", channel: "C1", ts: "1", text: "hi", user: "U1" } as SlackAppMentionEvent;
    expect(resolveChannelType(event)).toBe("public_channel");
  });

  it('returns "public_channel" when no channel_type field', () => {
    const event = { type: "message", channel: "C1", ts: "1" } as SlackMessageEvent;
    expect(resolveChannelType(event)).toBe("public_channel");
  });
});

describe("buildMessageContext", () => {
  it("returns null for ignored subtypes", () => {
    const ignoredSubtypes = [
      "channel_join",
      "channel_leave",
      "channel_topic",
      "channel_purpose",
      "channel_name",
      "channel_archive",
      "channel_unarchive",
      "bot_add",
      "bot_remove",
      "pinned_item",
      "unpinned_item",
    ];
    for (const subtype of ignoredSubtypes) {
      const event: SlackMessageEvent = {
        type: "message",
        channel: "C1",
        ts: "1",
        text: "hello",
        user: "U_USER",
        subtype,
      };
      expect(buildMessageContext(event, BOT_USER_ID)).toBeNull();
    }
  });

  it("returns null for bot messages (has bot_id)", () => {
    const event: SlackMessageEvent = {
      type: "message",
      channel: "C1",
      ts: "1",
      text: "hello",
      bot_id: "B123",
    };
    expect(buildMessageContext(event, BOT_USER_ID)).toBeNull();
  });

  it("returns null for messages from the bot user itself", () => {
    const event: SlackMessageEvent = {
      type: "message",
      channel: "C1",
      ts: "1",
      text: "hello",
      user: BOT_USER_ID,
    };
    expect(buildMessageContext(event, BOT_USER_ID)).toBeNull();
  });

  it("returns null for empty text with no files", () => {
    const event: SlackMessageEvent = {
      type: "message",
      channel: "C1",
      ts: "1",
      text: "",
      user: "U_USER",
    };
    expect(buildMessageContext(event, BOT_USER_ID)).toBeNull();
  });

  it("returns valid MessageContext for normal user messages", () => {
    const event: SlackMessageEvent = {
      type: "message",
      channel: "C1",
      ts: "123.456",
      text: "hello world",
      user: "U_USER",
      channel_type: "channel",
    };
    const ctx = buildMessageContext(event, BOT_USER_ID);
    expect(ctx).not.toBeNull();
    expect(ctx!.text).toBe("hello world");
    expect(ctx!.userId).toBe("U_USER");
    expect(ctx!.channelId).toBe("C1");
    expect(ctx!.channelType).toBe("public_channel");
    expect(ctx!.isDm).toBe(false);
  });

  it("correctly detects DM vs public channel", () => {
    const dmEvent: SlackMessageEvent = {
      type: "message",
      channel: "D1",
      ts: "1",
      text: "hey",
      user: "U_USER",
      channel_type: "im",
    };
    const ctx = buildMessageContext(dmEvent, BOT_USER_ID);
    expect(ctx).not.toBeNull();
    expect(ctx!.isDm).toBe(true);
    expect(ctx!.channelType).toBe("dm");
  });

  it("correctly detects @mention and strips it from text", () => {
    const event: SlackMessageEvent = {
      type: "message",
      channel: "C1",
      ts: "1",
      text: `<@${BOT_USER_ID}> what's the status?`,
      user: "U_USER",
      channel_type: "channel",
    };
    const ctx = buildMessageContext(event, BOT_USER_ID);
    expect(ctx).not.toBeNull();
    expect(ctx!.isMentioned).toBe(true);
    expect(ctx!.text).toBe("what's the status?");
  });

  it('correctly detects "Aura" addressed by name', () => {
    const event: SlackMessageEvent = {
      type: "message",
      channel: "C1",
      ts: "1",
      text: "Aura, can you help me?",
      user: "U_USER",
      channel_type: "channel",
    };
    const ctx = buildMessageContext(event, BOT_USER_ID);
    expect(ctx).not.toBeNull();
    expect(ctx!.isAddressedByName).toBe(true);
  });
});

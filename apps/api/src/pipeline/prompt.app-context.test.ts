import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageContext } from "./context.js";
import type { ConversationContext } from "./slack-context.js";
import type { AppContextEntity } from "../lib/app-context.js";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

const mocks = vi.hoisted(() => ({
  buildCorePromptMock: vi.fn(),
  getProfileMock: vi.fn(async () => null),
  formatConversationContextMock: vi.fn(async () => ""),
}));

vi.mock("./core-prompt.js", () => ({
  buildCorePrompt: mocks.buildCorePromptMock,
}));

vi.mock("../users/profiles.js", () => ({
  getProfile: mocks.getProfileMock,
}));

vi.mock("./slack-context.js", () => ({
  formatConversationContext: mocks.formatConversationContextMock,
}));

// Transitive deps of ./context.js (resolveChannelName import) — not exercised here.
vi.mock("../lib/ai.js", () => ({
  getFastModel: vi.fn(),
  withCacheControl: vi.fn(),
}));
vi.mock("../lib/langfuse.js", () => ({
  aiTelemetry: vi.fn(),
  withTrace: vi.fn(),
}));
vi.mock("../tools/slack.js", () => ({
  resolveChannelById: vi.fn(),
}));
vi.mock("../db/client.js", () => ({
  db: {},
}));

const { assemblePrompt } = await import("./prompt.js");

const channelEntity: AppContextEntity = {
  type: "slack#/types/channel_id",
  value: "C0123ABCDE",
  team_id: "T123",
};

function makeContext(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    text: "check this out",
    userId: "U123",
    channelId: "D123",
    channelType: "dm",
    messageTs: "1788249000.000100",
    isDm: true,
    isMentioned: false,
    isAddressedByName: false,
    ...overrides,
  };
}

const emptyConversation: ConversationContext = {
  thread: null,
  recentMessages: [],
  isAuraParticipant: false,
  isAuraThread: false,
  auraRecentlyActive: false,
};

describe("assemblePrompt — app context injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProfileMock.mockResolvedValue(null);
    mocks.formatConversationContextMock.mockResolvedValue("");
    mocks.buildCorePromptMock.mockResolvedValue({
      stablePrefix: "STABLE",
      environmentContext: "ENV",
      conversationContext: "CONV",
      dynamicContext: "BASE",
      memories: [],
      conversations: [],
      userProfile: null,
    });
  });

  it("injects the current-view block for a DM with fresh app context", async () => {
    const result = await assemblePrompt(
      makeContext({ appContextEntities: [channelEntity] }),
      emptyConversation,
    );

    expect(result.dynamicContext).toContain("## User's current view");
    expect(result.dynamicContext).toContain("a channel (<#C0123ABCDE>)");
    expect(result.dynamicContext).toContain("read that artifact FIRST");
    // The base dynamic context is preserved, block appended after it.
    expect(result.dynamicContext.startsWith("BASE")).toBe(true);
  });

  it("does NOT inject for non-DM conversations even when entities are present", async () => {
    const result = await assemblePrompt(
      makeContext({
        isDm: false,
        channelType: "public_channel",
        channelId: "C999",
        appContextEntities: [channelEntity],
      }),
      emptyConversation,
    );

    expect(result.dynamicContext).not.toContain("## User's current view");
  });

  it("does NOT inject when no app context was resolved", async () => {
    const result = await assemblePrompt(makeContext(), emptyConversation);

    expect(result.dynamicContext).not.toContain("## User's current view");
    expect(result.dynamicContext).toBe("BASE");
  });
});

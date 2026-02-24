import { describe, it, expect } from "vitest";
import { filterMemoriesByPrivacy } from "../lib/privacy.js";
import type { Memory } from "../db/schema.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    content: "test memory",
    type: "fact",
    sourceMessageId: null,
    sourceChannelType: "public_channel",
    relatedUserIds: [],
    embedding: null,
    relevanceScore: 1.0,
    shareable: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Memory;
}

describe("filterMemoriesByPrivacy", () => {
  it("channel-sourced memories always pass through", () => {
    const memories = [
      makeMemory({ sourceChannelType: "public_channel" }),
      makeMemory({ sourceChannelType: "private_channel" }),
    ];
    const result = filterMemoriesByPrivacy(memories, "U_OTHER");
    expect(result).toHaveLength(2);
  });

  it("DM memories are visible to related users", () => {
    const memories = [
      makeMemory({
        sourceChannelType: "dm",
        relatedUserIds: ["U_ALICE", "U_BOB"],
      }),
    ];
    const result = filterMemoriesByPrivacy(memories, "U_ALICE");
    expect(result).toHaveLength(1);
  });

  it("DM memories marked shareable pass through", () => {
    const memories = [
      makeMemory({
        sourceChannelType: "dm",
        relatedUserIds: ["U_ALICE"],
        shareable: 1,
      }),
    ];
    const result = filterMemoriesByPrivacy(memories, "U_OTHER");
    expect(result).toHaveLength(1);
  });

  it("DM memories NOT related and NOT shareable are filtered out", () => {
    const memories = [
      makeMemory({
        sourceChannelType: "dm",
        relatedUserIds: ["U_ALICE"],
        shareable: 0,
      }),
    ];
    const result = filterMemoriesByPrivacy(memories, "U_OTHER");
    expect(result).toHaveLength(0);
  });

  it("empty array input returns empty array", () => {
    const result = filterMemoriesByPrivacy([], "U_ANY");
    expect(result).toEqual([]);
  });
});

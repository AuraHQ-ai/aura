import { describe, it, expect } from "vitest";
import { filterMemoriesByPrivacy } from "./privacy.js";

function makeMemory(overrides: Record<string, unknown>) {
  return {
    id: "mem-1",
    content: "test memory",
    type: "fact",
    sourceChannelType: "channel",
    relatedUserIds: [] as string[],
    shareable: 0,
    ...overrides,
  } as any;
}

describe("filterMemoriesByPrivacy", () => {
  it("passes through channel memories", () => {
    const memories = [makeMemory({ sourceChannelType: "channel" })];
    const result = filterMemoriesByPrivacy(memories, "U_OTHER");
    expect(result).toHaveLength(1);
  });

  it("filters DM memories for non-related users", () => {
    const memories = [
      makeMemory({
        sourceChannelType: "dm",
        relatedUserIds: ["U_ALICE", "U_BOB"],
      }),
    ];
    const result = filterMemoriesByPrivacy(memories, "U_CHARLIE");
    expect(result).toHaveLength(0);
  });

  it("shows DM memories to related users", () => {
    const memories = [
      makeMemory({
        sourceChannelType: "dm",
        relatedUserIds: ["U_ALICE", "U_BOB"],
      }),
    ];
    const result = filterMemoriesByPrivacy(memories, "U_ALICE");
    expect(result).toHaveLength(1);
  });

  it("shows shareable DM memories to anyone", () => {
    const memories = [
      makeMemory({
        sourceChannelType: "dm",
        relatedUserIds: ["U_ALICE"],
        shareable: 1,
      }),
    ];
    const result = filterMemoriesByPrivacy(memories, "U_CHARLIE");
    expect(result).toHaveLength(1);
  });
});

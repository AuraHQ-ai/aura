import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../db/client.js", () => ({ db: {} }));
import { formatUserProfile } from "./system-prompt.js";
import type { UserProfile } from "@aura/db/schema";

function makeUserProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  const now = new Date("2026-04-17T12:00:00Z");
  return {
    id: "11111111-1111-1111-1111-111111111111",
    workspaceId: "default",
    slackUserId: "U_TEST",
    displayName: "Test User",
    timezone: "Europe/Zurich",
    personId: null,
    jobTitle: null,
    gender: null,
    preferredLanguage: "en",
    birthdate: null,
    managerId: null,
    notes: null,
    entityId: null,
    communicationStyle: {
      verbosity: "moderate",
      formality: "neutral",
      emojiUsage: "light",
      preferredFormat: "mixed",
    },
    knownFacts: {
      personalDetails: ["legacy known facts should not appear"],
    },
    role: "member",
    interactionCount: 42,
    lastInteractionAt: now,
    lastProfileConsolidation: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("formatUserProfile unified profile v2", () => {
  const originalFlag = process.env.UNIFIED_PROFILE_V2;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.UNIFIED_PROFILE_V2;
    } else {
      process.env.UNIFIED_PROFILE_V2 = originalFlag;
    }
  });

  it("includes he/him pronouns for gender=male and excludes known_facts prose", () => {
    process.env.UNIFIED_PROFILE_V2 = "true";
    const profile = makeUserProfile({
      gender: "male",
      preferredLanguage: "fr",
      role: "owner",
    });

    const text = formatUserProfile(profile, {
      interlocutorEntitySummary: "Leads platform strategy and architecture decisions.",
    });

    expect(text).toContain("Pronouns: he/him/his (gender=male)");
    expect(text).toContain("Compiled profile (entities.summary): Leads platform strategy and architecture decisions.");
    expect(text).not.toContain("legacy known facts should not appear");
    expect(text).not.toContain("Personal:");
  });

  it("falls back to they/them pronouns when gender is null", () => {
    process.env.UNIFIED_PROFILE_V2 = "true";
    const profile = makeUserProfile({
      gender: null,
    });

    const text = formatUserProfile(profile, {
      interlocutorEntitySummary: null,
    });

    expect(text).toContain("Pronouns: they/them/their (gender=null)");
    expect(text).toContain("Compiled profile (entities.summary): No profile compiled yet.");
    expect(text).not.toContain("legacy known facts should not appear");
  });
});

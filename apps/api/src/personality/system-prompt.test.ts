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

describe("person block snapshot", () => {
  const originalFlag = process.env.UNIFIED_PROFILE_V2;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.UNIFIED_PROFILE_V2;
    } else {
      process.env.UNIFIED_PROFILE_V2 = originalFlag;
    }
  });

  it("renders the expected <person> block shape for a male owner", () => {
    process.env.UNIFIED_PROFILE_V2 = "true";
    const profile = makeUserProfile({
      displayName: "Joan Rodriguez",
      gender: "male",
      preferredLanguage: "en",
      role: "owner",
      timezone: "Europe/Zurich",
    });

    const text = formatUserProfile(profile, {
      interlocutorEntitySummary: "Joan is a co-founder at RealAdvisor focused on product strategy.",
    });

    // Assert structural ordering - not free-form string comparison.
    const lines = text.split("\n");
    expect(lines[0]).toBe("About the person you're talking to:");
    expect(lines[1]).toBe("Display name: Joan Rodriguez");
    expect(lines[2]).toBe("Pronouns: he/him/his (gender=male)");
    expect(lines[3]).toBe("Preferred language: en");
    expect(lines[4]).toBe("Role: owner");
    expect(text).toContain("Timezone: Europe/Zurich");
    expect(text).toContain("Compiled profile (entities.summary): Joan is a co-founder");
    expect(text).not.toContain("known_facts");
    expect(text).not.toContain("personalDetails");
  });

  it("renders the expected <person> block shape for a female member", () => {
    process.env.UNIFIED_PROFILE_V2 = "true";
    const profile = makeUserProfile({
      displayName: "Jane Doe",
      gender: "female",
      preferredLanguage: "fr",
      role: "member",
    });

    const text = formatUserProfile(profile, {
      interlocutorEntitySummary: "Jane leads customer success.",
    });

    expect(text).toContain("Pronouns: she/her/hers (gender=female)");
    expect(text).toContain("Preferred language: fr");
    expect(text).toContain("Compiled profile (entities.summary): Jane leads customer success.");
    expect(text).not.toContain("legacy known facts should not appear");
  });

  it("omits preferred language line when null rather than rendering empty value", () => {
    process.env.UNIFIED_PROFILE_V2 = "true";
    const profile = makeUserProfile({
      gender: "male",
      preferredLanguage: null,
    });

    const text = formatUserProfile(profile, {
      interlocutor: { slackUserId: "U_TEST", displayName: null, gender: null, preferredLanguage: null, jobTitle: null, managerName: null, notes: null },
      interlocutorEntitySummary: null,
    });

    // Line should be absent entirely, not rendered as "Preferred language: null" or "Preferred language: "
    expect(text).not.toMatch(/Preferred language:\s*$/m);
    expect(text).not.toContain("Preferred language: null");
    expect(text).not.toContain("Preferred language: undefined");
  });
});

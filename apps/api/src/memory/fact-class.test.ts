import { describe, expect, it } from "vitest";
import {
  expiryFieldsForFactClass,
  FACT_CLASS_TTL_DAYS,
  isMemoryFactClass,
  MEMORY_FACT_CLASSES,
  needsVerifyBeforeAsserting,
  validUntilForFactClass,
} from "./fact-class.js";

describe("fact-class expiry policy (#1557 / #1171)", () => {
  const validFrom = new Date("2026-10-01T00:00:00.000Z");

  it("recognizes only the extractor-assigned volatile classes", () => {
    expect(MEMORY_FACT_CLASSES).toEqual(["access", "permissions", "pricing", "url", "tool_status"]);
    expect(isMemoryFactClass("access")).toBe(true);
    expect(isMemoryFactClass("event")).toBe(false);
    expect(isMemoryFactClass("open_thread")).toBe(false);
    expect(isMemoryFactClass(null)).toBe(false);
    expect(isMemoryFactClass(undefined)).toBe(false);
  });

  it("maps class → valid_until from validFrom, not a type-level formula", () => {
    expect(validUntilForFactClass("access", validFrom)).toEqual(
      new Date("2026-10-15T00:00:00.000Z"),
    );
    expect(validUntilForFactClass("permissions", validFrom)).toEqual(
      new Date("2026-10-15T00:00:00.000Z"),
    );
    expect(validUntilForFactClass("pricing", validFrom)).toEqual(
      new Date("2026-10-31T00:00:00.000Z"),
    );
    expect(validUntilForFactClass("url", validFrom)).toEqual(new Date("2026-10-31T00:00:00.000Z"));
    expect(validUntilForFactClass("tool_status", validFrom)).toEqual(
      new Date("2026-10-08T00:00:00.000Z"),
    );
    expect(FACT_CLASS_TTL_DAYS.tool_status).toBe(7);
  });

  it("does not synthesize expiry for durable / unclassified facts", () => {
    expect(expiryFieldsForFactClass(undefined, validFrom)).toEqual({});
    expect(expiryFieldsForFactClass(null, validFrom)).toEqual({});
    expect(expiryFieldsForFactClass("event", validFrom)).toEqual({});
    expect(expiryFieldsForFactClass("fact", validFrom)).toEqual({});
  });

  it("returns factClass + validUntil only when the extractor assigned a class", () => {
    expect(expiryFieldsForFactClass("access", validFrom)).toEqual({
      factClass: "access",
      validUntil: new Date("2026-10-15T00:00:00.000Z"),
    });
  });

  it("marks volatile classes as verify-before-asserting", () => {
    expect(needsVerifyBeforeAsserting("access")).toBe(true);
    expect(needsVerifyBeforeAsserting("tool_status")).toBe(true);
    expect(needsVerifyBeforeAsserting(null)).toBe(false);
    expect(needsVerifyBeforeAsserting("preference")).toBe(false);
  });
});

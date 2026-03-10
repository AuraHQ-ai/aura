import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isAdmin } from "./permissions.js";

describe("isAdmin", () => {
  const originalEnv = process.env.AURA_ADMIN_USER_IDS;

  beforeEach(() => {
    delete process.env.AURA_ADMIN_USER_IDS;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AURA_ADMIN_USER_IDS = originalEnv;
    } else {
      delete process.env.AURA_ADMIN_USER_IDS;
    }
  });

  it("returns false when env var is unset", () => {
    expect(isAdmin("U123")).toBe(false);
  });

  it("returns true for a matching admin ID", () => {
    process.env.AURA_ADMIN_USER_IDS = "U123,U456";
    expect(isAdmin("U123")).toBe(true);
  });

  it("returns false for a non-matching ID", () => {
    process.env.AURA_ADMIN_USER_IDS = "U123,U456";
    expect(isAdmin("U999")).toBe(false);
  });

  it("returns false for undefined userId", () => {
    process.env.AURA_ADMIN_USER_IDS = "U123";
    expect(isAdmin(undefined)).toBe(false);
  });
});

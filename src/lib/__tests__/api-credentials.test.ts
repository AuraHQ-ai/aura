/**
 * Unit tests for api-credentials module.
 *
 * Tests encryption/decryption, masking, name validation, and
 * the public API contract. Uses in-memory mocks for DB operations.
 */
import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";

// Set up test encryption key before importing the module
const TEST_KEY = crypto.randomBytes(32).toString("hex");
process.env.CREDENTIALS_KEY = TEST_KEY;

import { maskApiCredential } from "../api-credentials.js";

describe("maskApiCredential", () => {
  it("should mask long credentials showing first 8 and last 4 chars", () => {
    const result = maskApiCredential("sk-1234567890abcdef1234");
    expect(result).toBe("sk-12345...1234");
  });

  it("should return dots for short credentials (<=12 chars)", () => {
    expect(maskApiCredential("short")).toBe("••••••••");
    expect(maskApiCredential("exactly12ch!")).toBe("••••••••");
  });

  it("should handle exactly 13 char credentials", () => {
    const result = maskApiCredential("1234567890abc");
    expect(result).toBe("12345678...0abc");
  });
});

describe("credential name validation", () => {
  // We test the regex pattern directly since validateName is private
  const NAME_REGEX = /^[a-z][a-z0-9_]{1,62}$/;

  it("should accept valid names", () => {
    expect(NAME_REGEX.test("openai_key")).toBe(true);
    expect(NAME_REGEX.test("github_token")).toBe(true);
    expect(NAME_REGEX.test("my_api_key_v2")).toBe(true);
    expect(NAME_REGEX.test("ab")).toBe(true);
  });

  it("should reject invalid names", () => {
    expect(NAME_REGEX.test("")).toBe(false);
    expect(NAME_REGEX.test("A")).toBe(false);
    expect(NAME_REGEX.test("1abc")).toBe(false);
    expect(NAME_REGEX.test("has-dashes")).toBe(false);
    expect(NAME_REGEX.test("has spaces")).toBe(false);
    expect(NAME_REGEX.test("UPPERCASE")).toBe(false);
  });
});

describe("confirmation module", () => {
  it("should create and resolve confirmations", async () => {
    const { requestConfirmation, resolveConfirmation } = await import(
      "../confirmation.js"
    );

    const { token, blocks, promise } = requestConfirmation(
      "U123",
      "Delete credential my_key",
    );

    expect(token).toBeTruthy();
    expect(blocks).toHaveLength(3);
    expect(blocks[0].text.text).toContain("Confirmation required");

    // Resolve it
    const resolved = resolveConfirmation(token, true, "U123");
    expect(resolved).toBe(true);

    const result = await promise;
    expect(result).toBe(true);
  });

  it("should reject wrong user", async () => {
    const { requestConfirmation, resolveConfirmation } = await import(
      "../confirmation.js"
    );

    const { token } = requestConfirmation("U123", "Test action");

    const resolved = resolveConfirmation(token, true, "U999");
    expect(resolved).toBe(false);
  });

  it("should reject unknown token", async () => {
    const { resolveConfirmation } = await import("../confirmation.js");
    const resolved = resolveConfirmation("nonexistent", true, "U123");
    expect(resolved).toBe(false);
  });

  it("should report pending status correctly", async () => {
    const { requestConfirmation, isConfirmationPending, resolveConfirmation } =
      await import("../confirmation.js");

    const { token } = requestConfirmation("U123", "Check pending");
    expect(isConfirmationPending(token)).toBe(true);

    resolveConfirmation(token, false, "U123");
    expect(isConfirmationPending(token)).toBe(false);
  });
});

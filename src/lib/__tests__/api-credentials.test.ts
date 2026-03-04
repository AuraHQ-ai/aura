import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// Mock the database layer to avoid DATABASE_URL requirement
vi.mock("../../db/client.js", () => ({
  db: {},
}));

vi.mock("../settings.js", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Generate a real 32-byte key for tests
const TEST_KEY = crypto.randomBytes(32).toString("hex");

beforeEach(() => {
  vi.stubEnv("CREDENTIALS_KEY", TEST_KEY);
});

describe("encryptCredential / decryptCredential roundtrip", () => {
  it("encrypts and decrypts to the same value", async () => {
    const { encryptCredential, decryptCredential } = await import(
      "../credentials.js"
    );
    const plain = "ghp_abc123_my_super_secret_token";
    const encrypted = encryptCredential(plain);
    expect(encrypted).not.toBe(plain);
    expect(encrypted).toContain(":");
    const decrypted = decryptCredential(encrypted);
    expect(decrypted).toBe(plain);
  });

  it("produces different ciphertext each time (random IV)", async () => {
    const { encryptCredential } = await import("../credentials.js");
    const plain = "same_value";
    const a = encryptCredential(plain);
    const b = encryptCredential(plain);
    expect(a).not.toBe(b);
  });

  it("throws on invalid ciphertext format", async () => {
    const { decryptCredential } = await import("../credentials.js");
    expect(() => decryptCredential("not:valid")).toThrow("Invalid ciphertext format");
  });
});

describe("credential name validation", () => {
  const NAME_RE = /^[a-z][a-z0-9_]{1,62}$/;

  it("accepts valid names", () => {
    expect(NAME_RE.test("github_token")).toBe(true);
    expect(NAME_RE.test("airbyte_api_token")).toBe(true);
    expect(NAME_RE.test("a1")).toBe(true);
    expect(NAME_RE.test("my_credential_123")).toBe(true);
  });

  it("rejects invalid names", () => {
    expect(NAME_RE.test("")).toBe(false);
    expect(NAME_RE.test("A")).toBe(false);
    expect(NAME_RE.test("1starts_with_number")).toBe(false);
    expect(NAME_RE.test("has-dashes")).toBe(false);
    expect(NAME_RE.test("has spaces")).toBe(false);
    expect(NAME_RE.test("UPPERCASE")).toBe(false);
    expect(NAME_RE.test("a")).toBe(false);
    expect(NAME_RE.test("a" + "b".repeat(63))).toBe(false);
  });
});

describe("maskApiCredential", () => {
  it("masks short tokens (< 8 chars) showing first 1 + last 1", async () => {
    const { maskApiCredential } = await import("../api-credentials.js");
    expect(maskApiCredential("abcd")).toBe("a***d");
    expect(maskApiCredential("xy")).toBe("x***y");
    expect(maskApiCredential("1234567")).toBe("1***7");
  });

  it("masks medium tokens (8-11 chars) showing first 2 + last 2", async () => {
    const { maskApiCredential } = await import("../api-credentials.js");
    expect(maskApiCredential("12345678")).toBe("12***78");
    expect(maskApiCredential("abcdefghijk")).toBe("ab***jk");
  });

  it("masks long tokens (12+ chars) showing first 4 + last 4", async () => {
    const { maskApiCredential } = await import("../api-credentials.js");
    expect(maskApiCredential("123456789012")).toBe("1234***9012");
    const hundredChar = "a".repeat(100);
    expect(maskApiCredential(hundredChar)).toBe("aaaa***aaaa");
  });
});

describe("permission hierarchy", () => {
  const PERMISSION_LEVELS: Record<string, number> = {
    read: 1,
    write: 2,
    admin: 3,
  };

  function hasPermission(
    granted: string,
    required: "read" | "write",
  ): boolean {
    return (
      (PERMISSION_LEVELS[granted] ?? 0) >=
      (PERMISSION_LEVELS[required] ?? 0)
    );
  }

  it("read grants read access", () => {
    expect(hasPermission("read", "read")).toBe(true);
  });

  it("read does not grant write access", () => {
    expect(hasPermission("read", "write")).toBe(false);
  });

  it("write grants both read and write access", () => {
    expect(hasPermission("write", "read")).toBe(true);
    expect(hasPermission("write", "write")).toBe(true);
  });

  it("admin grants all access", () => {
    expect(hasPermission("admin", "read")).toBe(true);
    expect(hasPermission("admin", "write")).toBe(true);
  });

  it("unknown permission grants nothing", () => {
    expect(hasPermission("unknown", "read")).toBe(false);
    expect(hasPermission("unknown", "write")).toBe(false);
  });
});

describe("resolveConfirmation", () => {
  it("returns null for nonexistent token", async () => {
    const { resolveConfirmation } = await import("../confirmation.js");
    expect(resolveConfirmation("nonexistent_token")).toBe(null);
  });
});

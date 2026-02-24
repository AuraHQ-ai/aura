import { describe, it, expect } from "vitest";
import { maskCredential } from "../lib/credentials.js";

describe("maskCredential", () => {
  it('short strings (<=12 chars) return "••••••••"', () => {
    expect(maskCredential("abc")).toBe("••••••••");
    expect(maskCredential("123456789012")).toBe("••••••••");
  });

  it("longer strings show first 8 and last 4 chars with ... in between", () => {
    expect(maskCredential("abcdefghijklmnop")).toBe("abcdefgh...mnop");
  });

  it("edge case: exactly 13 chars", () => {
    const value = "1234567890123";
    expect(maskCredential(value)).toBe("12345678...0123");
  });
});

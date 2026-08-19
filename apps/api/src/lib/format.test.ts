import { describe, it, expect } from "vitest";
import { formatForSlack } from "./format.js";

describe("formatForSlack", () => {
  it("converts **bold** to *bold*", () => {
    expect(formatForSlack("This is **bold** text")).toBe(
      "This is *bold* text",
    );
  });

  it("converts markdown headers to bold", () => {
    expect(formatForSlack("## Heading")).toBe("*Heading*");
  });

  it("preserves code blocks", () => {
    const input = "```\nconst x = 1;\n```";
    expect(formatForSlack(input)).toBe(input);
  });

  it("preserves inline code", () => {
    const input = "Use `**not bold**` in code";
    expect(formatForSlack(input)).toBe("Use `**not bold**` in code");
  });

  it("wraps markdown tables in code fences", () => {
    const input = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const result = formatForSlack(input);
    expect(result).toContain("```");
    expect(result).toContain("A");
    expect(result).toContain("B");
  });
});

import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@example.com/db";

const { sanitizeErrorText } = await import("./error-logger.js");

function numericArray(length: number): string {
  return `[${Array.from({ length }, (_, i) => ((i + 1) / 1000).toFixed(4)).join(",")}]`;
}

describe("sanitizeErrorText", () => {
  it("leaves clean text unchanged", () => {
    const input = "duplicate key value violates unique constraint";

    expect(sanitizeErrorText(input)).toBe(input);
  });

  it("leaves short numeric arrays unchanged", () => {
    const input = "params: [1,2,3,4,5]";

    expect(sanitizeErrorText(input)).toBe(input);
  });

  it("strips a Postgres embedding vector dump", () => {
    const input = `Failed query: insert into messages values ($1) params: ${numericArray(1536)}`;
    const output = sanitizeErrorText(input);

    expect(output).toContain("floats omitted");
    expect(output).toContain("1536 floats omitted");
    expect(output.length).toBeLessThan(500);
  });

  it("strips multiple embeddings in one message", () => {
    const input = `first=${numericArray(32)} second=${numericArray(64)}`;
    const output = sanitizeErrorText(input);

    expect(output.match(/floats omitted/g)).toHaveLength(2);
    expect(output).toContain("32 floats omitted");
    expect(output).toContain("64 floats omitted");
  });

  it("truncates long stack traces with a marker", () => {
    const input = `Error: failed\n${"at frame\n".repeat(300)}`;
    const output = sanitizeErrorText(input);

    expect(output).toContain("truncated, original");
    expect(output.length).toBeLessThan(input.length);
  });

  it("returns an empty string for nullish input", () => {
    expect(sanitizeErrorText(null)).toBe("");
    expect(sanitizeErrorText(undefined)).toBe("");
  });
});

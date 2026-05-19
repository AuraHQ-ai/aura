import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {},
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { buildDynamicContext } from "./system-prompt.js";

function extractCapabilitiesBlock(prompt: string): string {
  const match = prompt.match(/<capabilities>[\s\S]*<\/capabilities>/);
  return match?.[0] ?? "";
}

describe("buildDynamicContext capabilities", () => {
  it("renders sorted sandbox credential names in the expected format", () => {
    const prompt = buildDynamicContext({
      sandboxEnvNames: ["NOTION_API_KEY", "GITHUB_TOKEN"],
    });

    const expected = `<capabilities>
You have these credentials/API keys available in your sandbox env (run_command, etc.). Names only — never paste or log values. Use them when relevant; don't claim you "don't have access" without checking first.
- GITHUB_TOKEN
- NOTION_API_KEY
</capabilities>`;

    expect(extractCapabilitiesBlock(prompt)).toBe(expected);
    expect(prompt.indexOf("</runtime>")).toBeLessThan(
      prompt.indexOf("<capabilities>"),
    );
  });

  it("does not include credential values in the capabilities block", () => {
    const secretValue = "secret_notion_value_123";
    const prompt = buildDynamicContext({
      usageStats: `debug value that must not be in capabilities: ${secretValue}`,
      sandboxEnvNames: ["NOTION_API_KEY"],
    });

    const block = extractCapabilitiesBlock(prompt);
    expect(block).toContain("- NOTION_API_KEY");
    expect(block).not.toContain(secretValue);
  });

  it("omits the capabilities block when no credential names are available", () => {
    expect(buildDynamicContext({ sandboxEnvNames: [] })).not.toContain(
      "<capabilities>",
    );
    expect(buildDynamicContext({})).not.toContain("<capabilities>");
  });
});

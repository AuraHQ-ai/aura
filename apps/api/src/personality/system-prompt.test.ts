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

import { buildDynamicContext, formatDeferredTools } from "./system-prompt.js";

function extractCapabilitiesBlock(prompt: string): string {
  const match = prompt.match(/<capabilities>[\s\S]*<\/capabilities>/);
  return match?.[0] ?? "";
}

describe("buildDynamicContext capabilities", () => {
  it("renders sorted sandbox credential names grouped by capability", () => {
    const prompt = buildDynamicContext({
      sandboxEnvNames: ["NOTION_API_KEY", "GITHUB_TOKEN"],
    });

    const expected = `<capabilities>
You have access to these systems from the sandbox environment. Credential names are identifiers only -- never paste or log values. Prefer typed Aura tools and safe CLIs before raw HTTP/API calls.

Hard rule: Seeing a credential name is not a reason to use it -- it's a reason to check if a typed tool wraps it. Before \`curl\` with a secret, run \`tool_search_tool_bm25\` for the domain.

- GitHub: \`GITHUB_TOKEN\` -- prefer the \`gh\` CLI in the sandbox; for issue/PR ops use it directly
- Other available credentials: \`NOTION_API_KEY\` -- search typed tools for the relevant domain before raw API use
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
    expect(block).toContain("`NOTION_API_KEY`");
    expect(block).not.toContain(secretValue);
  });

  it("contains the hard guardrail line inside the capabilities block", () => {
    const prompt = buildDynamicContext({
      sandboxEnvNames: ["SLACK_BOT_TOKEN"],
    });

    expect(extractCapabilitiesBlock(prompt)).toContain(
      "Seeing a credential name is not a reason to use it -- it's a reason to check if a typed tool wraps it. Before `curl` with a secret, run `tool_search_tool_bm25` for the domain.",
    );
  });

  it("annotates CURSOR_API_KEY with Cursor tool wrappers when present", () => {
    const prompt = buildDynamicContext({
      sandboxEnvNames: ["CURSOR_API_KEY"],
      availableToolNames: ["dispatch_cursor_agent", "check_cursor_agent"],
    });

    const block = extractCapabilitiesBlock(prompt);
    expect(block).toContain("`CURSOR_API_KEY`");
    expect(block).toContain("`dispatch_cursor_agent`");
    expect(block).toContain("`check_cursor_agent`");
  });

  it("omits the capabilities block when no credential names are available", () => {
    expect(buildDynamicContext({ sandboxEnvNames: [] })).not.toContain(
      "<capabilities>",
    );
    expect(buildDynamicContext({})).not.toContain("<capabilities>");
  });
});

describe("deferred tools manifest", () => {
  it("renders a deferred_tools block when deferred tools exist", () => {
    const prompt = buildDynamicContext({
      deferredTools: [
        {
          name: "dispatch_cursor_agent",
          description: "dispatch async coding agent to Aura repo",
        },
        {
          name: "check_cursor_agent",
          description: "check status of dispatched agent",
        },
      ],
    });

    expect(prompt).toContain(`<deferred_tools>
Available on demand (call tool_search_tool_bm25 to load schemas):
- check_cursor_agent: check status of dispatched agent
- dispatch_cursor_agent: dispatch async coding agent to Aura repo
</deferred_tools>`);
  });

  it("excludes manifest entries that are already immediate tools", () => {
    const manifest = formatDeferredTools(
      [
        {
          name: "dispatch_cursor_agent",
          description: "dispatch async coding agent to Aura repo",
        },
        {
          name: "run_command",
          description: "run shell commands in the sandbox",
        },
      ],
      ["run_command"],
    );

    expect(manifest).toContain("- dispatch_cursor_agent:");
    expect(manifest).not.toContain("run_command");
  });

  it("omits the deferred_tools block when there are no deferred tools", () => {
    expect(buildDynamicContext({ deferredTools: [] })).not.toContain(
      "<deferred_tools>",
    );
    expect(formatDeferredTools(undefined)).toBe("");
  });
});

describe("buildDynamicContext storage block", () => {
  it("includes the MongoDB storage block when MONGODB_ATLAS_URI is in env names", () => {
    const prompt = buildDynamicContext({
      sandboxEnvNames: ["MONGODB_ATLAS_URI", "GITHUB_TOKEN"],
    });
    expect(prompt).toContain("<storage>");
    expect(prompt).toContain("MongoDB Atlas");
    expect(prompt).toContain("fb_comments");
    expect(prompt).toContain("DATABASE_URL");
  });

  it("omits the storage block when MONGODB_ATLAS_URI is not present", () => {
    const prompt = buildDynamicContext({
      sandboxEnvNames: ["GITHUB_TOKEN", "NOTION_API_KEY"],
    });
    expect(prompt).not.toContain("<storage>");
    expect(prompt).not.toContain("MongoDB Atlas");
  });

  it("omits the storage block when sandboxEnvNames is empty", () => {
    expect(buildDynamicContext({ sandboxEnvNames: [] })).not.toContain(
      "<storage>",
    );
    expect(buildDynamicContext({})).not.toContain("<storage>");
  });
});

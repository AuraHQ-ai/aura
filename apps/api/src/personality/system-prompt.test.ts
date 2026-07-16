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

import {
  buildDynamicContext,
  buildEnvironmentContext,
  formatDeferredTools,
} from "./system-prompt.js";
import { buildCachedSystemMessages } from "../lib/ai.js";

function extractCapabilitiesBlock(prompt: string): string {
  const match = prompt.match(/<capabilities>[\s\S]*<\/capabilities>/);
  return match?.[0] ?? "";
}

describe("buildEnvironmentContext capabilities", () => {
  it("renders sorted sandbox credential names grouped by capability", () => {
    const prompt = buildEnvironmentContext({
      sandboxEnvNames: ["NOTION_API_KEY", "GITHUB_TOKEN"],
    });

    const expected = `<capabilities>
Scoped secrets are available as environment variables in the sandbox. The names below are identifiers only -- never paste or log secret values. There is no \`get_credential\` or \`http_request\` tool.

To call external APIs, use sandbox \`curl\`, \`python\`, or \`typescript\` and read the key from its env var (for example: \`-H "X-Claap-Key: $CLAAP_API_KEY"\`). For workflows that need a real browser, use \`browse\` (Browserbase) with stealth mode. Prefer typed Aura tools and safe CLIs when they exist.

Hard rule: handle secret names only; never print env var values, echo secrets, or include them in logs or chat.

- GitHub: \`GITHUB_TOKEN\` -- prefer the \`gh\` CLI in the sandbox; for issue/PR ops use it directly
- Other available credentials: \`NOTION_API_KEY\` -- use from sandbox env vars when no typed tool or safe CLI fits
</capabilities>`;

    expect(extractCapabilitiesBlock(prompt)).toBe(expected);
  });

  it("does not include credential values in the capabilities block", () => {
    const block = extractCapabilitiesBlock(
      buildEnvironmentContext({ sandboxEnvNames: ["NOTION_API_KEY"] }),
    );
    expect(block).toContain("`NOTION_API_KEY`");
    expect(block).not.toContain("secret_notion_value_123");
  });

  it("contains the hard guardrail line inside the capabilities block", () => {
    const prompt = buildEnvironmentContext({
      sandboxEnvNames: ["SLACK_BOT_TOKEN"],
    });

    expect(extractCapabilitiesBlock(prompt)).toContain(
      "Hard rule: handle secret names only; never print env var values, echo secrets, or include them in logs or chat.",
    );
  });

  it("annotates CURSOR_API_KEY with Cursor tool wrappers when present", () => {
    const prompt = buildEnvironmentContext({
      sandboxEnvNames: ["CURSOR_API_KEY"],
      availableToolNames: ["dispatch_cursor_agent", "check_cursor_agent"],
    });

    const block = extractCapabilitiesBlock(prompt);
    expect(block).toContain("`CURSOR_API_KEY`");
    expect(block).toContain("`dispatch_cursor_agent`");
    expect(block).toContain("`check_cursor_agent`");
  });

  it("omits the capabilities block when no credential names are available", () => {
    expect(buildEnvironmentContext({ sandboxEnvNames: [] })).not.toContain(
      "<capabilities>",
    );
    expect(buildEnvironmentContext({})).toBe("");
  });

  it("annotates caller-scoped credentials with owner provenance", () => {
    const block = extractCapabilitiesBlock(
      buildEnvironmentContext({
        sandboxEnvNames: [
          { envName: "GITHUB_TOKEN", scope: "owner", ownerDisplayName: "Callan Corrado" },
          { envName: "NOTION_API_KEY", scope: "per_user", ownerDisplayName: "Nia Otieno" },
          { envName: "SLACK_BOT_TOKEN", scope: "member", ownerDisplayName: null },
        ],
      }),
    );

    expect(block).toContain(
      "- GitHub: `GITHUB_TOKEN` (owner-scoped, resolved for caller: Callan Corrado) -- prefer the `gh` CLI",
    );
    expect(block).toContain(
      "`NOTION_API_KEY` (per-user-scoped, resolved for caller: Nia Otieno)",
    );
    // Shared/role-tier rows stay bare names.
    expect(block).toContain("- Slack: `SLACK_BOT_TOKEN` ->");
    expect(block).not.toContain("`SLACK_BOT_TOKEN` (");
  });

  it("annotates caller-scoped credentials without a display name using scope only", () => {
    const block = extractCapabilitiesBlock(
      buildEnvironmentContext({
        sandboxEnvNames: [
          { envName: "GITHUB_TOKEN", scope: "owner", ownerDisplayName: null },
        ],
      }),
    );

    expect(block).toContain("`GITHUB_TOKEN` (owner-scoped, resolved for caller)");
  });
});

describe("buildDynamicContext runtime block", () => {
  it("renders runtime and never carries the environment blocks", () => {
    const runtime = buildDynamicContext({
      modelId: "anthropic/claude-opus-4.8",
      channelId: "C123",
      usageStats: "## Usage\nUnique users: 5",
    });
    expect(runtime).toContain("<runtime>");
    expect(runtime).toContain("Active model: `anthropic/claude-opus-4.8`");
    expect(runtime).toContain("Unique users: 5");
    expect(runtime).not.toContain("<capabilities>");
    expect(runtime).not.toContain("<storage>");
    expect(runtime).not.toContain("<deferred_tools>");
  });
});

describe("deferred tools manifest", () => {
  it("renders a deferred_tools block when deferred tools exist", () => {
    const prompt = buildEnvironmentContext({
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
    expect(buildEnvironmentContext({ deferredTools: [] })).not.toContain(
      "<deferred_tools>",
    );
    expect(formatDeferredTools(undefined)).toBe("");
  });
});

describe("buildEnvironmentContext storage block", () => {
  it("includes the MongoDB storage block when MONGODB_ATLAS_URI is in env names", () => {
    const prompt = buildEnvironmentContext({
      sandboxEnvNames: ["MONGODB_ATLAS_URI", "GITHUB_TOKEN"],
    });
    expect(prompt).toContain("<storage>");
    expect(prompt).toContain("MongoDB Atlas");
    expect(prompt).toContain("fb_comments");
    expect(prompt).toContain("DATABASE_URL");
  });

  it("omits the storage block when MONGODB_ATLAS_URI is not present", () => {
    const prompt = buildEnvironmentContext({
      sandboxEnvNames: ["GITHUB_TOKEN", "NOTION_API_KEY"],
    });
    expect(prompt).not.toContain("<storage>");
    expect(prompt).not.toContain("MongoDB Atlas");
  });

  it("omits the storage block when sandboxEnvNames is empty", () => {
    expect(buildEnvironmentContext({ sandboxEnvNames: [] })).not.toContain(
      "<storage>",
    );
    expect(buildEnvironmentContext({})).toBe("");
  });
});

describe("buildCachedSystemMessages layering", () => {
  it("orders environment before conversation and leaves runtime uncached last", () => {
    const messages = buildCachedSystemMessages(
      "<personality>P</personality>",
      "<capabilities>C</capabilities>",
      "<context>X</context>\n\n<conversation>T</conversation>",
      "<runtime>R</runtime>",
    );

    expect(messages.map((m) => m.content)).toEqual([
      "<personality>P</personality>",
      "<capabilities>C</capabilities>",
      "<context>X</context>\n\n<conversation>T</conversation>",
      "<runtime>R</runtime>",
    ]);

    // The three stable layers are cached; the volatile runtime tail is not.
    expect(messages[0].providerOptions).toBeDefined();
    expect(messages[1].providerOptions).toBeDefined();
    expect(messages[2].providerOptions).toBeDefined();
    expect(messages[3].providerOptions).toBeUndefined();
  });

  it("skips empty environment and conversation layers", () => {
    const messages = buildCachedSystemMessages("<personality>P</personality>", "", "", undefined);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("<personality>P</personality>");
  });
});

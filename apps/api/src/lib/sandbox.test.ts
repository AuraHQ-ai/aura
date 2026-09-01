import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const state = {
    results: [] as unknown[][],
    select: vi.fn(),
  };

  function createQuery() {
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(state.results.shift() ?? []).then(onFulfilled, onRejected),
    };
    return query;
  }

  state.select.mockImplementation(() => createQuery());

  return state;
});

const decryptCredentialMock = vi.hoisted(() => vi.fn((value: string) => value));
const resolveUserCredentialsMock = vi.hoisted(() => vi.fn());
const recordErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../db/client.js", () => ({
  db: {
    select: dbMock.select,
  },
}));

vi.mock("./credentials.js", () => ({
  decryptCredential: decryptCredentialMock,
}));

vi.mock("./permissions.js", () => ({
  resolveUserCredentials: resolveUserCredentialsMock,
}));

vi.mock("./settings.js", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./metrics.js", () => ({
  recordError: recordErrorMock,
}));

import { logger } from "./logger.js";
import { getSetting } from "./settings.js";
import { executionContext } from "./tool.js";
import { filterToolsByCredentials } from "./tool.js";
import {
  ensureAuraTools,
  getSandboxEnvs,
  getSandboxEnvNames,
  filterEnvsByAllowlist,
  filterCredentialNamesByEnvAllowlist,
} from "./sandbox.js";

const getSettingMock = vi.mocked(getSetting);
const loggerWarnMock = vi.mocked(logger.warn);

interface CredentialRow {
  id: string;
  name: string;
  value: string;
  ownerId: string;
  scope: string;
  sandboxEnvName: string | null;
}

function queueDbResults(...results: unknown[][]) {
  dbMock.results = [...results];
}

const callerCredential: CredentialRow = {
  id: "cred-caller",
  name: "github_token",
  value: "caller-token",
  ownerId: "U_CALLER",
  scope: "owner",
  sandboxEnvName: null,
};

const otherCredential: CredentialRow = {
  id: "cred-other",
  name: "github_token",
  value: "other-token",
  ownerId: "U_OTHER",
  scope: "member",
  sandboxEnvName: null,
};

describe("getSandboxEnvs", () => {
  beforeEach(() => {
    queueDbResults();
    vi.clearAllMocks();
    resolveUserCredentialsMock.mockResolvedValue(new Set(["github_token"]));
  });

  it.each([
    [[callerCredential, otherCredential], "caller row first"],
    [[otherCredential, callerCredential], "caller row last"],
  ])("prefers caller-owned credentials on env name collisions (%s)", async (rows) => {
    queueDbResults([], rows);

    const envs = await getSandboxEnvs("U_CALLER");

    expect(envs.GITHUB_TOKEN).toBe("caller-token");
    expect(envs.GH_TOKEN).toBe("caller-token");
  });

  it("does not inject another user's per_user credential with the same name", async () => {
    queueDbResults(
      [],
      [
        callerCredential,
        {
          ...otherCredential,
          id: "cred-per-user",
          value: "other-per-user-token",
          scope: "per_user",
        },
      ],
    );

    const envs = await getSandboxEnvs("U_CALLER");

    expect(envs.GITHUB_TOKEN).toBe("caller-token");
  });
});

describe("getSandboxEnvs env allowlist (scoped job execution)", () => {
  const memberCredential = (name: string, value: string): CredentialRow => ({
    id: `cred-${name}`,
    name,
    value,
    ownerId: "U_OWNER",
    scope: "member",
    sandboxEnvName: null,
  });

  const rows = [
    memberCredential("meta_admin_token", "meta-secret"),
    memberCredential("slack_bot_token", "slack-secret"),
    memberCredential("anthropic_api_key", "anthropic-secret"),
    memberCredential("github_token", "github-secret"),
    memberCredential("e2b_api_key", "e2b-secret"),
  ];

  beforeEach(() => {
    queueDbResults();
    vi.clearAllMocks();
    resolveUserCredentialsMock.mockResolvedValue(
      new Set(rows.map((row) => row.name)),
    );
  });

  it("filters to allowlisted vars plus core infra when the execution context carries an allowlist", async () => {
    queueDbResults([], rows);

    const envs = await executionContext.run(
      {
        triggeredBy: "U_CALLER",
        triggerType: "scheduled_job",
        envAllowlist: ["META_ADMIN_TOKEN", "SLACK_BOT_TOKEN"],
      },
      () => getSandboxEnvs("U_CALLER"),
    );

    // Allowlisted vars present
    expect(envs.META_ADMIN_TOKEN).toBe("meta-secret");
    expect(envs.SLACK_BOT_TOKEN).toBe("slack-secret");
    // Non-listed credentials absent
    expect(envs.ANTHROPIC_API_KEY).toBeUndefined();
    expect(envs.GITHUB_TOKEN).toBeUndefined();
    expect(envs.GH_TOKEN).toBeUndefined();
    // Core infra passes through so the sandbox can still boot
    expect(envs.E2B_API_KEY).toBe("e2b-secret");
  });

  it("returns the full env set when no allowlist is in the execution context", async () => {
    queueDbResults([], rows);

    const envs = await executionContext.run(
      { triggeredBy: "U_CALLER", triggerType: "scheduled_job" },
      () => getSandboxEnvs("U_CALLER"),
    );

    expect(envs.META_ADMIN_TOKEN).toBe("meta-secret");
    expect(envs.ANTHROPIC_API_KEY).toBe("anthropic-secret");
    expect(envs.GITHUB_TOKEN).toBe("github-secret");
    expect(envs.GH_TOKEN).toBe("github-secret");
  });

  it("returns the full env set outside any execution context", async () => {
    queueDbResults([], rows);

    const envs = await getSandboxEnvs("U_CALLER");

    expect(envs.ANTHROPIC_API_KEY).toBe("anthropic-secret");
    expect(envs.GITHUB_TOKEN).toBe("github-secret");
  });

  it("an empty allowlist keeps only core infra vars", async () => {
    queueDbResults([], rows);

    const envs = await executionContext.run(
      {
        triggeredBy: "U_CALLER",
        triggerType: "scheduled_job",
        envAllowlist: [],
      },
      () => getSandboxEnvs("U_CALLER"),
    );

    expect(Object.keys(envs).sort()).toEqual(["E2B_API_KEY"]);
  });
});

describe("filterEnvsByAllowlist", () => {
  const envs = {
    META_ADMIN_TOKEN: "meta-secret",
    SLACK_BOT_TOKEN: "slack-secret",
    ANTHROPIC_API_KEY: "anthropic-secret",
    GITHUB_TOKEN: "github-secret",
    GH_TOKEN: "github-secret",
    E2B_API_KEY: "e2b-secret",
    E2B_TEMPLATE_ID: "template-1",
  };

  it("keeps allowlisted and core infra vars, drops the rest", () => {
    const filtered = filterEnvsByAllowlist(envs, ["META_ADMIN_TOKEN"]);

    expect(filtered).toEqual({
      META_ADMIN_TOKEN: "meta-secret",
      E2B_API_KEY: "e2b-secret",
      E2B_TEMPLATE_ID: "template-1",
    });
  });

  it("matches allowlist entries case-insensitively", () => {
    const filtered = filterEnvsByAllowlist(envs, ["meta_admin_token"]);

    expect(filtered.META_ADMIN_TOKEN).toBe("meta-secret");
    expect(filtered.SLACK_BOT_TOKEN).toBeUndefined();
  });

  it("allows the GH_TOKEN alias when GITHUB_TOKEN is allowlisted", () => {
    const filtered = filterEnvsByAllowlist(envs, ["GITHUB_TOKEN"]);

    expect(filtered.GITHUB_TOKEN).toBe("github-secret");
    expect(filtered.GH_TOKEN).toBe("github-secret");
  });

  it("narrows only — allowlisted names not in the env map are not added", () => {
    const filtered = filterEnvsByAllowlist(
      { E2B_API_KEY: "e2b-secret" },
      ["SOME_TOKEN_THE_CALLER_CANNOT_ACCESS"],
    );

    expect(filtered).toEqual({ E2B_API_KEY: "e2b-secret" });
  });

  it("returns the map unchanged for a null allowlist (full inheritance)", () => {
    expect(filterEnvsByAllowlist(envs, null)).toEqual(envs);
    expect(filterEnvsByAllowlist(envs, undefined)).toEqual(envs);
  });
});

describe("filterCredentialNamesByEnvAllowlist (issue #1312)", () => {
  it("keeps credentials whose uppercased name is allowlisted, drops the rest", () => {
    const filtered = filterCredentialNamesByEnvAllowlist(
      new Set(["meta_admin_token", "tavily_api_key", "google_bq_credentials"]),
      ["TAVILY_API_KEY"],
    );

    expect(filtered).toEqual(new Set(["tavily_api_key"]));
  });

  it("matches through the credential's explicit sandbox env name", () => {
    const filtered = filterCredentialNamesByEnvAllowlist(
      new Set(["meta_ads_system_user", "tavily_api_key"]),
      ["META_ADMIN_TOKEN"],
      new Map([["meta_ads_system_user", "META_ADMIN_TOKEN"]]),
    );

    expect(filtered).toEqual(new Set(["meta_ads_system_user"]));
  });

  it("keeps core infra credentials and the GH_TOKEN alias", () => {
    const filtered = filterCredentialNamesByEnvAllowlist(
      new Set(["e2b_api_key", "github_token", "slack_bot_token"]),
      ["GH_TOKEN"],
    );

    // e2b_api_key maps to core infra env E2B_API_KEY; github_token via alias.
    expect(filtered).toEqual(new Set(["e2b_api_key", "github_token"]));
  });

  it("returns the set unchanged for a null allowlist (full inheritance)", () => {
    const names = new Set(["github_token", "tavily_api_key"]);
    expect(filterCredentialNamesByEnvAllowlist(names, null)).toEqual(names);
    expect(filterCredentialNamesByEnvAllowlist(names, undefined)).toEqual(names);
  });

  it("an empty allowlist keeps only core-infra-backed credentials (fail closed)", () => {
    const filtered = filterCredentialNamesByEnvAllowlist(
      new Set(["google_bq_credentials", "google_oauth", "e2b_api_key"]),
      [],
    );

    expect(filtered).toEqual(new Set(["e2b_api_key"]));
  });

  it("gates credential-backed typed tools when combined with filterToolsByCredentials", () => {
    // Plain objects standing in for defineTool() output — filterToolsByCredentials
    // only reads the __requiredCredentials metadata.
    const tools = {
      bq_execute_query: { __requiredCredentials: ["google_bq_credentials"] },
      web_search: { __requiredCredentials: ["tavily_api_key"] },
      read_note: {},
    };
    const userCredentials = new Set(["google_bq_credentials", "tavily_api_key"]);

    const scoped = filterCredentialNamesByEnvAllowlist(userCredentials, [
      "TAVILY_API_KEY",
    ]);
    const filtered = filterToolsByCredentials(tools, scoped);

    // bq_execute_query's backing credential is outside the allowlist → omitted.
    // Credential-free tools are unaffected.
    expect(Object.keys(filtered).sort()).toEqual(["read_note", "web_search"]);
  });
});

describe("getSandboxEnvNames", () => {
  beforeEach(() => {
    queueDbResults();
    vi.clearAllMocks();
    resolveUserCredentialsMock.mockResolvedValue(new Set<string>());
  });

  it("applies the owner-scoped gate and resolves owner display names", async () => {
    const rows: CredentialRow[] = [
      {
        id: "owned",
        name: "github_token",
        value: "owned-secret-value",
        ownerId: "U_CALLER",
        scope: "owner",
        sandboxEnvName: "GITHUB_TOKEN",
      },
      {
        id: "granted",
        name: "notion_api_key",
        value: "granted-secret-value",
        ownerId: "U_OTHER",
        scope: "owner",
        sandboxEnvName: "NOTION_API_KEY",
      },
      {
        id: "blocked",
        name: "linear_api_key",
        value: "blocked-secret-value",
        ownerId: "U_OTHER",
        scope: "owner",
        sandboxEnvName: "LINEAR_API_KEY",
      },
    ];
    queueDbResults(
      [{ credentialId: "granted" }],
      rows,
      [
        { slackUserId: "U_CALLER", displayName: "Callan Corrado" },
        { slackUserId: "U_OTHER", displayName: "Nia Otieno" },
      ],
    );
    resolveUserCredentialsMock.mockResolvedValue(
      new Set(["github_token", "notion_api_key", "linear_api_key"]),
    );

    await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([
      { envName: "GITHUB_TOKEN", scope: "owner", ownerDisplayName: "Callan Corrado" },
      { envName: "NOTION_API_KEY", scope: "owner", ownerDisplayName: "Nia Otieno" },
    ]);
  });

  it("returns null ownerDisplayName when the owner has no users row", async () => {
    queueDbResults(
      [],
      [
        {
          id: "owned",
          name: "github_token",
          value: "owned-secret-value",
          ownerId: "U_CALLER",
          scope: "owner",
          sandboxEnvName: "GITHUB_TOKEN",
        },
      ],
      [], // users lookup returns no rows
    );
    resolveUserCredentialsMock.mockResolvedValue(new Set(["github_token"]));

    await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([
      { envName: "GITHUB_TOKEN", scope: "owner", ownerDisplayName: null },
    ]);
  });

  it("honors Gate 1 for per_user-scoped credentials with and without grants", async () => {
    const perUserCredential: CredentialRow = {
      id: "per-user",
      name: "notion_api_key",
      value: "notion-secret-value",
      ownerId: "U_OWNER",
      scope: "per_user",
      sandboxEnvName: "NOTION_API_KEY",
    };

    queueDbResults([], [perUserCredential]);
    resolveUserCredentialsMock.mockResolvedValue(new Set<string>());
    await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([]);

    dbMock.select.mockClear();
    queueDbResults(
      [{ credentialId: "per-user" }],
      [perUserCredential],
      [{ slackUserId: "U_OWNER", displayName: "Nia Otieno" }],
    );
    resolveUserCredentialsMock.mockResolvedValue(new Set(["notion_api_key"]));

    await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([
      { envName: "NOTION_API_KEY", scope: "per_user", ownerDisplayName: "Nia Otieno" },
    ]);
  });

  it("returns role-tier credentials as global rows without owner metadata", async () => {
    const rows: CredentialRow[] = [
      {
        id: "member",
        name: "member_token",
        value: "member-secret-value",
        ownerId: "U_OWNER",
        scope: "member",
        sandboxEnvName: "MEMBER_TOKEN",
      },
      {
        id: "power",
        name: "power_token",
        value: "power-secret-value",
        ownerId: "U_OWNER",
        scope: "power_user",
        sandboxEnvName: null,
      },
      {
        id: "admin",
        name: "admin_token",
        value: "admin-secret-value",
        ownerId: "U_OWNER",
        scope: "admin",
        sandboxEnvName: "ADMIN_TOKEN",
      },
    ];
    queueDbResults([], rows);
    resolveUserCredentialsMock.mockResolvedValue(
      new Set(["member_token", "power_token"]),
    );

    await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([
      { envName: "MEMBER_TOKEN", scope: "member", ownerDisplayName: null },
      { envName: "POWER_TOKEN", scope: "power_user", ownerDisplayName: null },
    ]);
  });

  it.each([
    ["caller row first", true],
    ["caller row last", false],
  ])(
    "prefers the caller-owned row's metadata on env name collisions (%s)",
    async (_label, callerFirst) => {
      const callerRow: CredentialRow = {
        id: "cred-caller",
        name: "github_token",
        value: "caller-token",
        ownerId: "U_CALLER",
        scope: "owner",
        sandboxEnvName: null,
      };
      const sharedRow: CredentialRow = {
        id: "cred-shared",
        name: "github_token",
        value: "shared-token",
        ownerId: "U_OTHER",
        scope: "member",
        sandboxEnvName: null,
      };
      queueDbResults(
        [],
        callerFirst ? [callerRow, sharedRow] : [sharedRow, callerRow],
        [{ slackUserId: "U_CALLER", displayName: "Callan Corrado" }],
      );
      resolveUserCredentialsMock.mockResolvedValue(new Set(["github_token"]));

      await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([
        { envName: "GITHUB_TOKEN", scope: "owner", ownerDisplayName: "Callan Corrado" },
      ]);
    },
  );

  it("does not select or decrypt credential values", async () => {
    queueDbResults(
      [],
      [
        {
          id: "secret",
          name: "secret_token",
          value: "super-secret-value",
          ownerId: "U_CALLER",
          scope: "owner",
          sandboxEnvName: "SECRET_TOKEN",
        },
      ],
      [{ slackUserId: "U_CALLER", displayName: "Callan Corrado" }],
    );
    resolveUserCredentialsMock.mockResolvedValue(new Set(["secret_token"]));

    await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([
      { envName: "SECRET_TOKEN", scope: "owner", ownerDisplayName: "Callan Corrado" },
    ]);

    const selectedValue = dbMock.select.mock.calls.some(([selection]) =>
      Object.keys(selection ?? {}).includes("value"),
    );
    expect(selectedValue).toBe(false);
    expect(decryptCredentialMock).not.toHaveBeenCalled();
  });
});

describe("ensureAuraTools", () => {
  const checkoutPath = `/home/user/${["aura", "tools"].join("-")}`;
  const markerPath = `${checkoutPath}/.aura-tools-synced`;
  const repoProbe = `if [ -f '${markerPath}' ] && [ -n "$(find '${markerPath}' -mmin -30 2>/dev/null)" ]; then echo AURA_TOOLS_FRESH; elif git -C '${checkoutPath}' rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo AURA_TOOLS_PRESENT; else echo AURA_TOOLS_MISSING; fi`;
  const installAndTouch = `if [ -f '${checkoutPath}/requirements.txt' ]; then python3 -m pip install --quiet --disable-pip-version-check -r '${checkoutPath}/requirements.txt' || echo AURA_TOOLS_DEPS_FAILED; fi; touch '${markerPath}'`;
  const touchOnly = `touch '${markerPath}'`;

  // The session cache in sandbox.ts is module state keyed on sandbox id, so
  // every test needs a unique id to stay isolated.
  let sandboxIdCounter = 0;
  function makeSandbox(
    run: (
      command: string,
      options?: { timeoutMs?: number; envs?: Record<string, string> },
    ) => Promise<{ exitCode?: number; stdout?: string; stderr?: string }>,
  ) {
    return { sandboxId: `sbx-test-${sandboxIdCounter++}`, commands: { run } };
  }

  /**
   * Mirrors the real E2B SDK behavior: `commands.run()` THROWS a
   * `CommandExitError` (carrying exitCode/stdout/stderr) on any non-zero
   * exit instead of returning a result. Mocks that RETURN `{ exitCode: 128 }`
   * are exactly why issue #1363 was never caught by tests.
   */
  class FakeCommandExitError extends Error {
    constructor(
      private readonly result: { exitCode: number; stdout: string; stderr: string },
    ) {
      super(`exit status ${result.exitCode}`);
      this.name = "CommandExitError";
    }
    get exitCode() {
      return this.result.exitCode;
    }
    get stdout() {
      return this.result.stdout;
    }
    get stderr() {
      return this.result.stderr;
    }
  }

  function commandResult({
    exitCode = 0,
    stdout = "",
    stderr = "",
  }: { exitCode?: number; stdout?: string; stderr?: string }) {
    if (exitCode !== 0) {
      throw new FakeCommandExitError({ exitCode, stdout, stderr });
    }
    return { exitCode, stdout, stderr };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getSettingMock.mockResolvedValue(null);
  });

  it("clones the default realadvisor/aura-tools repo when tools_repo is not configured (issue #960)", async () => {
    const run = vi.fn(async (command: string, _options?: unknown) => {
      if (command.startsWith("if [ -f")) {
        return commandResult({ stdout: "AURA_TOOLS_MISSING\n" });
      }
      return commandResult({});
    });

    await ensureAuraTools(makeSandbox(run), { GITHUB_TOKEN: "token" });

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      repoProbe,
      `git clone --depth=1 "https://x-access-token:$GITHUB_TOKEN@github.com/realadvisor/aura-tools.git" '${checkoutPath}'`,
      installAndTouch,
    ]);
    expect(loggerWarnMock).not.toHaveBeenCalled();
    expect(recordErrorMock).not.toHaveBeenCalled();
  });

  it("clones the configured repository when the checkout is missing", async () => {
    getSettingMock.mockResolvedValue("acme/tools");
    const run = vi.fn(async (command: string, _options?: unknown) => {
      if (command.startsWith("if [ -f")) {
        // The shell guard absorbs git's non-zero exit — the command exits 0.
        return commandResult({ stdout: "AURA_TOOLS_MISSING\n" });
      }
      return commandResult({});
    });

    await ensureAuraTools(makeSandbox(run), { GITHUB_TOKEN: "token" });

    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[1][0]).toContain(
      'git clone --depth=1 "https://x-access-token:$GITHUB_TOKEN@github.com/acme/tools.git"',
    );
    expect(run.mock.calls[1][0]).not.toContain("token@");
    expect(run.mock.calls[1][1]).toMatchObject({
      envs: { GITHUB_TOKEN: "token" },
    });
    // Python deps install after the clone, then the freshness marker is set.
    expect(run.mock.calls[2][0]).toBe(installAndTouch);
    expect(loggerWarnMock).not.toHaveBeenCalled();
    expect(recordErrorMock).not.toHaveBeenCalled();
  });

  it("still clones when the existence probe THROWS like the real SDK (issue #1363)", async () => {
    getSettingMock.mockResolvedValue("acme/tools");
    const run = vi.fn(async (command: string, _options?: unknown) => {
      if (command.startsWith("if [ -f")) {
        // Real SDK behavior for a failing probe without the shell guard:
        // the command exits non-zero and commands.run() throws CommandExitError.
        return commandResult({ exitCode: 128, stderr: "fatal: not a git repository" });
      }
      return commandResult({});
    });

    await ensureAuraTools(makeSandbox(run), { GITHUB_TOKEN: "token" });

    const cloneCall = run.mock.calls.find(([command]) =>
      command.startsWith("git clone"),
    );
    expect(cloneCall).toBeDefined();
    expect(cloneCall![0]).toContain(
      'git clone --depth=1 "https://x-access-token:$GITHUB_TOKEN@github.com/acme/tools.git"',
    );
    expect(recordErrorMock).not.toHaveBeenCalled();
  });

  it("is a single probe with no git traffic when the sync marker is fresh", async () => {
    const run = vi.fn(async (command: string, _options?: unknown) => {
      if (command.startsWith("if [ -f")) {
        return commandResult({ stdout: "AURA_TOOLS_FRESH\n" });
      }
      return commandResult({});
    });

    await ensureAuraTools(makeSandbox(run), { GITHUB_TOKEN: "token" });

    expect(run.mock.calls.map(([command]) => command)).toEqual([repoProbe]);
    expect(loggerWarnMock).not.toHaveBeenCalled();
    expect(recordErrorMock).not.toHaveBeenCalled();
  });

  it("syncs only once per session per sandbox id", async () => {
    const run = vi.fn(async (command: string, _options?: unknown) => {
      if (command.startsWith("if [ -f")) {
        return commandResult({ stdout: "AURA_TOOLS_MISSING\n" });
      }
      return commandResult({});
    });
    const sandbox = makeSandbox(run);

    await ensureAuraTools(sandbox, { GITHUB_TOKEN: "token" });
    await ensureAuraTools(sandbox, { GITHUB_TOKEN: "token" });

    // Second acquisition of the same sandbox issues zero commands.
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      repoProbe,
      `git clone --depth=1 "https://x-access-token:$GITHUB_TOKEN@github.com/realadvisor/aura-tools.git" '${checkoutPath}'`,
      installAndTouch,
    ]);
  });

  it("pulls when the checkout exists but the marker is stale, skipping pip when unchanged", async () => {
    getSettingMock.mockResolvedValue("https://github.com/acme/tools.git");
    const run = vi.fn(async (command: string, _options?: unknown) => {
      if (command.startsWith("if [ -f")) {
        return commandResult({ stdout: "AURA_TOOLS_PRESENT\n" });
      }
      if (command.includes("pull --ff-only")) {
        return commandResult({ stdout: "Already up to date." });
      }
      return commandResult({});
    });

    await ensureAuraTools(makeSandbox(run), { GITHUB_TOKEN: "token" });

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      repoProbe,
      `git -C '${checkoutPath}' pull --ff-only`,
      touchOnly,
    ]);
    expect(loggerWarnMock).not.toHaveBeenCalled();
    expect(recordErrorMock).not.toHaveBeenCalled();
  });

  it("reinstalls Python deps when the pull brought new commits", async () => {
    const run = vi.fn(async (command: string, _options?: unknown) => {
      if (command.startsWith("if [ -f")) {
        return commandResult({ stdout: "AURA_TOOLS_PRESENT\n" });
      }
      if (command.includes("pull --ff-only")) {
        return commandResult({ stdout: "Updating 1a2b3c..4d5e6f\nFast-forward\n" });
      }
      return commandResult({});
    });

    await ensureAuraTools(makeSandbox(run), { GITHUB_TOKEN: "token" });

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      repoProbe,
      `git -C '${checkoutPath}' pull --ff-only`,
      installAndTouch,
    ]);
  });

  it("does not touch the marker when the pull fails, so the next acquisition retries", async () => {
    const run = vi.fn(async (command: string, _options?: unknown) => {
      if (command.startsWith("if [ -f")) {
        return commandResult({ stdout: "AURA_TOOLS_PRESENT\n" });
      }
      if (command.includes("pull --ff-only")) {
        return commandResult({ exitCode: 1, stderr: "fatal: unable to access" });
      }
      return commandResult({});
    });

    await ensureAuraTools(makeSandbox(run), { GITHUB_TOKEN: "token" });

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      repoProbe,
      `git -C '${checkoutPath}' pull --ff-only`,
    ]);
    expect(loggerWarnMock).toHaveBeenCalled();
  });

  it("records an error and issues no commands when GITHUB_TOKEN is unavailable", async () => {
    const run = vi.fn(async (_command: string, _options?: unknown) =>
      commandResult({}),
    );

    await ensureAuraTools(makeSandbox(run), {});

    expect(run).not.toHaveBeenCalled();
    expect(recordErrorMock).toHaveBeenCalledWith(
      "sandbox.ensureAuraTools",
      expect.any(Error),
      { toolsRepo: "realadvisor/aura-tools" },
    );
  });

  it("records an error but does not throw when clone fails", async () => {
    getSettingMock.mockResolvedValue("acme/tools");
    const run = vi.fn(async (command: string, _options?: unknown) => {
      if (command.startsWith("if [ -f")) {
        return commandResult({ stdout: "AURA_TOOLS_MISSING\n" });
      }
      if (command.startsWith("git clone")) {
        return commandResult({ exitCode: 128, stderr: "repository not found" });
      }
      return commandResult({});
    });

    await expect(
      ensureAuraTools(makeSandbox(run), { GITHUB_TOKEN: "token" }),
    ).resolves.toBeUndefined();

    expect(recordErrorMock).toHaveBeenCalledWith(
      "sandbox.ensureAuraTools",
      expect.any(Error),
      expect.objectContaining({
        toolsRepo: "acme/tools",
        checkoutPath,
        exitCode: 128,
        stderr: "repository not found",
      }),
    );
  });

  it("records genuine connection errors via recordError without throwing", async () => {
    getSettingMock.mockResolvedValue("acme/tools");
    const run = vi.fn(async (_command: string, _options?: unknown) => {
      // A transport failure carries no exitCode — runTolerant must re-throw it.
      throw new Error("sandbox connection lost");
    });

    await expect(
      ensureAuraTools(makeSandbox(run), { GITHUB_TOKEN: "token" }),
    ).resolves.toBeUndefined();

    expect(run.mock.calls.map(([command]) => command)).toEqual([repoProbe]);
    expect(recordErrorMock).toHaveBeenCalledWith(
      "sandbox.ensureAuraTools",
      expect.objectContaining({ message: "sandbox connection lost" }),
      { toolsRepo: "acme/tools", checkoutPath },
    );
  });
});

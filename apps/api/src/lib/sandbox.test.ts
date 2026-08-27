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

const recordErrorMock = vi.hoisted(() => vi.fn());

vi.mock("./metrics.js", () => ({
  recordError: recordErrorMock,
}));

import { logger } from "./logger.js";
import { getSetting } from "./settings.js";
import { executionContext } from "./tool.js";
import {
  bootstrapToolsRepo,
  getSandboxEnvs,
  getSandboxEnvNames,
  filterEnvsByAllowlist,
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

describe("bootstrapToolsRepo", () => {
  const checkoutPath = `/home/user/${["aura", "tools"].join("-")}`;
  const checkoutProbe = `test -d '${checkoutPath}'/.git && echo yes || echo no`;

  /** Error shaped like e2b v2's CommandExitError (implements CommandResult). */
  function commandExitError(
    exitCode: number,
    stderr: string,
    stdout = "",
  ): Error {
    return Object.assign(new Error(`exit status ${exitCode}`), {
      exitCode,
      stdout,
      stderr,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getSettingMock.mockResolvedValue(null);
  });

  it("skips cleanly when tools_repo is not configured", async () => {
    const run = vi.fn();

    await bootstrapToolsRepo({ commands: { run } }, { GITHUB_TOKEN: "token" });

    expect(run).not.toHaveBeenCalled();
    expect(loggerWarnMock).not.toHaveBeenCalled();
    expect(recordErrorMock).not.toHaveBeenCalled();
  });

  it("clones the configured repository when the checkout is missing", async () => {
    getSettingMock.mockResolvedValue("acme/tools");
    let checkoutExists = false;
    const run = vi.fn(async (command: string, _options?: unknown) => {
      if (command.includes("test -d")) {
        return { exitCode: 0, stdout: checkoutExists ? "yes\n" : "no\n", stderr: "" };
      }
      if (command.startsWith("git clone")) {
        checkoutExists = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await bootstrapToolsRepo({ commands: { run } }, { GITHUB_TOKEN: "token" });

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      checkoutProbe,
      `git clone "https://x-access-token:$GITHUB_TOKEN@github.com/acme/tools.git" '${checkoutPath}'`,
      checkoutProbe,
    ]);
    expect(run.mock.calls[1][0]).not.toContain("token@");
    expect(run.mock.calls[1][1]).toMatchObject({
      envs: { GITHUB_TOKEN: "token" },
    });
    expect(loggerWarnMock).not.toHaveBeenCalled();
    expect(recordErrorMock).not.toHaveBeenCalled();
  });

  it("still reaches the clone when the repo probe THROWS a CommandExitError (e2b v2 non-zero exit)", async () => {
    getSettingMock.mockResolvedValue("acme/tools");
    let checkoutExists = false;
    const run = vi.fn(async (command: string, _options?: unknown) => {
      if (command.includes("test -d")) {
        if (!checkoutExists) {
          // Simulate e2b v2 throwing on non-zero exit instead of returning.
          throw commandExitError(128, "fatal: not a git repository");
        }
        return { exitCode: 0, stdout: "yes\n", stderr: "" };
      }
      if (command.startsWith("git clone")) {
        checkoutExists = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await bootstrapToolsRepo({ commands: { run } }, { GITHUB_TOKEN: "token" });

    const cloneCalls = run.mock.calls.filter(([command]) =>
      command.startsWith("git clone"),
    );
    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0][0]).toContain(
      'git clone "https://x-access-token:$GITHUB_TOKEN@github.com/acme/tools.git"',
    );
    expect(recordErrorMock).not.toHaveBeenCalled();
  });

  it("pulls on re-acquire when the checkout is already a git repository", async () => {
    getSettingMock.mockResolvedValue("https://github.com/acme/tools.git");
    let checkoutExists = false;
    const run = vi.fn(async (command: string, _options?: unknown) => {
      if (command.includes("test -d")) {
        return { exitCode: 0, stdout: checkoutExists ? "yes\n" : "no\n", stderr: "" };
      }
      if (command.startsWith("git clone")) {
        checkoutExists = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.includes("pull --ff-only")) {
        return { exitCode: 0, stdout: "Already up to date.", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await bootstrapToolsRepo({ commands: { run } }, { GITHUB_TOKEN: "token" });
    await bootstrapToolsRepo({ commands: { run } }, { GITHUB_TOKEN: "token" });

    expect(run.mock.calls.map(([command]) => command)).toEqual([
      checkoutProbe,
      `git clone "https://x-access-token:$GITHUB_TOKEN@github.com/acme/tools.git" '${checkoutPath}'`,
      checkoutProbe,
      checkoutProbe,
      `git -C '${checkoutPath}' pull --ff-only`,
      checkoutProbe,
    ]);
    expect(loggerWarnMock).not.toHaveBeenCalled();
    expect(recordErrorMock).not.toHaveBeenCalled();
  });

  it("records an error (with redacted git auth) and does not throw when clone fails", async () => {
    getSettingMock.mockResolvedValue("acme/tools");
    const run = vi.fn(async (command: string, _options?: unknown) => {
      if (command.includes("test -d")) {
        return { exitCode: 0, stdout: "no\n", stderr: "" };
      }
      if (command.startsWith("git clone")) {
        // e2b v2 throws on non-zero exit; stderr carries the resolved URL.
        throw commandExitError(
          128,
          "fatal: unable to access 'https://x-access-token:ghs_secret123@github.com/acme/tools.git/': repository not found",
        );
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expect(
      bootstrapToolsRepo({ commands: { run } }, { GITHUB_TOKEN: "token" }),
    ).resolves.toBeUndefined();

    expect(recordErrorMock).toHaveBeenCalledTimes(1);
    const [component, error, context] = recordErrorMock.mock.calls[0];
    expect(component).toBe("sandbox.bootstrapToolsRepo");
    expect((error as Error).message).toBe(
      "Failed to clone configured tools repository",
    );
    expect(context).toMatchObject({
      toolsRepo: "acme/tools",
      checkoutPath,
      exitCode: 128,
    });
    expect(context.stderr).toContain("x-access-token:[REDACTED]@");
    expect(JSON.stringify(recordErrorMock.mock.calls[0])).not.toContain(
      "ghs_secret123",
    );
  });

  it("records an error when the checkout is still missing after a green clone", async () => {
    getSettingMock.mockResolvedValue("acme/tools");
    const run = vi.fn(async (command: string, _options?: unknown) => {
      if (command.includes("test -d")) {
        // Missing before AND after the clone: bootstrap must not read green.
        return { exitCode: 0, stdout: "no\n", stderr: "" };
      }
      if (command.startsWith("git clone")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await bootstrapToolsRepo({ commands: { run } }, { GITHUB_TOKEN: "token" });

    expect(recordErrorMock).toHaveBeenCalledWith(
      "sandbox.bootstrapToolsRepo",
      expect.objectContaining({
        message: "Tools repository checkout missing after bootstrap",
      }),
      expect.objectContaining({ toolsRepo: "acme/tools", checkoutPath }),
    );
  });

  it("records an error instead of silently warning when a non-exit error escapes", async () => {
    getSettingMock.mockResolvedValue("acme/tools");
    const run = vi.fn(async () => {
      throw new Error("transport closed");
    });

    await expect(
      bootstrapToolsRepo({ commands: { run } }, { GITHUB_TOKEN: "token" }),
    ).resolves.toBeUndefined();

    expect(recordErrorMock).toHaveBeenCalledWith(
      "sandbox.bootstrapToolsRepo",
      expect.objectContaining({ message: "transport closed" }),
      expect.objectContaining({ toolsRepo: "acme/tools", checkoutPath }),
    );
  });
});

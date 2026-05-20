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

import { logger } from "./logger.js";
import { getSetting } from "./settings.js";
import { bootstrapToolsRepo, getSandboxEnvs, getSandboxEnvNames } from "./sandbox.js";

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

describe("getSandboxEnvNames", () => {
  beforeEach(() => {
    queueDbResults();
    vi.clearAllMocks();
    resolveUserCredentialsMock.mockResolvedValue(new Set<string>());
  });

  it("applies the owner-scoped gate for owned, granted, and ungranted credentials", async () => {
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
    queueDbResults([{ credentialId: "granted" }], rows);
    resolveUserCredentialsMock.mockResolvedValue(
      new Set(["github_token", "notion_api_key", "linear_api_key"]),
    );

    await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([
      "GITHUB_TOKEN",
      "NOTION_API_KEY",
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
    queueDbResults([{ credentialId: "per-user" }], [perUserCredential]);
    resolveUserCredentialsMock.mockResolvedValue(new Set(["notion_api_key"]));

    await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([
      "NOTION_API_KEY",
    ]);
  });

  it("honors resolved role-tier credential access and falls back to uppercase names", async () => {
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
      "MEMBER_TOKEN",
      "POWER_TOKEN",
    ]);
  });

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
    );
    resolveUserCredentialsMock.mockResolvedValue(new Set(["secret_token"]));

    await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([
      "SECRET_TOKEN",
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

  beforeEach(() => {
    vi.clearAllMocks();
    getSettingMock.mockResolvedValue(null);
  });

  it("skips cleanly when tools_repo is not configured", async () => {
    const run = vi.fn();

    await bootstrapToolsRepo({ commands: { run } }, { GITHUB_TOKEN: "token" });

    expect(run).not.toHaveBeenCalled();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("clones the configured repository when the checkout is missing", async () => {
    getSettingMock.mockResolvedValue("acme/tools");
    const run = vi.fn(async (command: string) => {
      if (command.includes("rev-parse")) {
        return { exitCode: 128, stdout: "", stderr: "missing" };
      }
      if (command.startsWith("git clone")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await bootstrapToolsRepo({ commands: { run } }, { GITHUB_TOKEN: "token" });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toContain(
      'git clone "https://x-access-token:$GITHUB_TOKEN@github.com/acme/tools.git"',
    );
    expect(run.mock.calls[1][0]).not.toContain("token@");
    expect(run.mock.calls[1][1]).toMatchObject({
      envs: { GITHUB_TOKEN: "token" },
    });
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("pulls on re-acquire when the checkout is already a git repository", async () => {
    getSettingMock.mockResolvedValue("https://github.com/acme/tools.git");
    let checkoutExists = false;
    const run = vi.fn(async (command: string) => {
      if (command.includes("rev-parse")) {
        return { exitCode: checkoutExists ? 0 : 128, stdout: "", stderr: "" };
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
      `git -C '${checkoutPath}' rev-parse --is-inside-work-tree`,
      `git clone "https://x-access-token:$GITHUB_TOKEN@github.com/acme/tools.git" '${checkoutPath}'`,
      `git -C '${checkoutPath}' rev-parse --is-inside-work-tree`,
      `git -C '${checkoutPath}' pull --ff-only`,
    ]);
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("logs a warning but does not throw when clone fails", async () => {
    getSettingMock.mockResolvedValue("acme/tools");
    const run = vi.fn(async (command: string) => {
      if (command.includes("rev-parse")) {
        return { exitCode: 128, stdout: "", stderr: "missing" };
      }
      if (command.startsWith("git clone")) {
        return { exitCode: 128, stdout: "", stderr: "repository not found" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expect(
      bootstrapToolsRepo({ commands: { run } }, { GITHUB_TOKEN: "token" }),
    ).resolves.toBeUndefined();

    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Failed to clone configured tools repository",
      expect.objectContaining({
        toolsRepo: "acme/tools",
        exitCode: 128,
        stderr: "repository not found",
      }),
    );
  });
});

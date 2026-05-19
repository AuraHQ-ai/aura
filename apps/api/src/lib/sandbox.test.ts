import { describe, it, expect, beforeEach, vi } from "vitest";

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

const resolveUserCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock("../db/client.js", () => ({
  db: {
    select: dbMock.select,
  },
}));

vi.mock("./credentials.js", () => ({
  decryptCredential: vi.fn((value: string) => value),
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

function queueDbResults(...results: unknown[][]) {
  dbMock.results = [...results];
}

const callerCredential = {
  id: "cred-caller",
  name: "github_token",
  value: "caller-token",
  ownerId: "U_CALLER",
  scope: "owner",
  sandboxEnvName: null,
};

const otherCredential = {
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

    const { getSandboxEnvs } = await import("./sandbox.js");
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

    const { getSandboxEnvs } = await import("./sandbox.js");
    const envs = await getSandboxEnvs("U_CALLER");

    expect(envs.GITHUB_TOKEN).toBe("caller-token");
  });
});

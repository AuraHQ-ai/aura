import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { logger } from "./logger.js";

const dbMock = vi.hoisted(() => {
  const state = {
    results: [] as unknown[][],
    select: vi.fn(),
  };

  function createQuery() {
    const query: any = {
      from: vi.fn(() => query),
      innerJoin: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(state.results.shift() ?? []).then(onFulfilled, onRejected),
    };
    return query;
  }

  state.select.mockImplementation(() => createQuery());

  return state;
});

vi.mock("../db/client.js", () => ({
  db: {
    select: dbMock.select,
  },
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

describe("isAdmin", () => {
  const originalEnv = process.env.AURA_ADMIN_USER_IDS;

  beforeEach(() => {
    delete process.env.AURA_ADMIN_USER_IDS;
    queueDbResults();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AURA_ADMIN_USER_IDS = originalEnv;
    } else {
      delete process.env.AURA_ADMIN_USER_IDS;
    }
  });

  it("returns false when env var is unset", async () => {
    const { isAdmin } = await import("./permissions.js");
    expect(isAdmin("U123")).toBe(false);
  });

  it("returns true for a matching admin ID", async () => {
    const { isAdmin } = await import("./permissions.js");
    process.env.AURA_ADMIN_USER_IDS = "U123,U456";
    expect(isAdmin("U123")).toBe(true);
  });

  it("returns false for a non-matching ID", async () => {
    const { isAdmin } = await import("./permissions.js");
    process.env.AURA_ADMIN_USER_IDS = "U123,U456";
    expect(isAdmin("U999")).toBe(false);
  });

  it("returns false for undefined userId", async () => {
    const { isAdmin } = await import("./permissions.js");
    process.env.AURA_ADMIN_USER_IDS = "U123";
    expect(isAdmin(undefined)).toBe(false);
  });
});

describe("resolveUserCredentials", () => {
  const originalEnv = process.env.AURA_ADMIN_USER_IDS;

  beforeEach(() => {
    delete process.env.AURA_ADMIN_USER_IDS;
    queueDbResults();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AURA_ADMIN_USER_IDS = originalEnv;
    } else {
      delete process.env.AURA_ADMIN_USER_IDS;
    }
  });

  it("does not grant per_user credentials without ownership or an active grant, even for admins", async () => {
    process.env.AURA_ADMIN_USER_IDS = "U_ADMIN";
    queueDbResults(
      [],
      [
        {
          id: "cred-1",
          name: "github_token",
          scope: "per_user",
          ownerId: "U_OWNER",
        },
      ],
      [],
    );

    const { resolveUserCredentials } = await import("./permissions.js");
    const result = await resolveUserCredentials("U_ADMIN");

    expect(result.has("github_token")).toBe(false);
  });

  it("grants per_user credentials with an active grant", async () => {
    queueDbResults(
      [],
      [{ credentialId: "cred-1", credentialName: "github_token" }],
      [
        {
          id: "cred-1",
          name: "github_token",
          scope: "per_user",
          ownerId: "U_OWNER",
        },
      ],
      [],
    );

    const { resolveUserCredentials } = await import("./permissions.js");
    const result = await resolveUserCredentials("U_GRANTEE");

    expect(result.has("github_token")).toBe(true);
  });

  it("grants per_user credentials owned by the caller", async () => {
    queueDbResults(
      [],
      [],
      [
        {
          id: "cred-1",
          name: "github_token",
          scope: "per_user",
          ownerId: "U_OWNER",
        },
      ],
      [],
    );

    const { resolveUserCredentials } = await import("./permissions.js");
    const result = await resolveUserCredentials("U_OWNER");

    expect(result.has("github_token")).toBe(true);
  });

  it("intersects the credential set with an active env allowlist (issue #1312)", async () => {
    queueDbResults(
      [{ role: "member" }],
      [],
      [
        { id: "c1", name: "tavily_api_key", scope: "member", ownerId: "U_X", sandboxEnvName: null },
        { id: "c2", name: "google_bq_credentials", scope: "member", ownerId: "U_X", sandboxEnvName: null },
      ],
      [],
    );

    const { resolveUserCredentials } = await import("./permissions.js");
    const { executionContext } = await import("./tool.js");

    const result = await executionContext.run(
      {
        triggeredBy: "U1",
        triggerType: "scheduled_job",
        callingUserId: "U1",
        envAllowlist: ["TAVILY_API_KEY"],
      },
      () => resolveUserCredentials("U1"),
    );

    expect(result).toEqual(new Set(["tavily_api_key"]));
  });

  it("matches allowlist entries via sandbox_env_name and the GH_TOKEN alias", async () => {
    queueDbResults(
      [{ role: "member" }],
      [],
      [
        {
          id: "c1",
          name: "meta_ads_system_user",
          scope: "member",
          ownerId: "U_X",
          sandboxEnvName: "META_ADMIN_TOKEN",
        },
        { id: "c2", name: "github_token", scope: "member", ownerId: "U_X", sandboxEnvName: null },
        { id: "c3", name: "slack_bot_token", scope: "member", ownerId: "U_X", sandboxEnvName: null },
      ],
      [],
    );

    const { resolveUserCredentials } = await import("./permissions.js");
    const { executionContext } = await import("./tool.js");

    const result = await executionContext.run(
      {
        triggeredBy: "U1",
        triggerType: "scheduled_job",
        callingUserId: "U1",
        envAllowlist: ["META_ADMIN_TOKEN", "GH_TOKEN"],
      },
      () => resolveUserCredentials("U1"),
    );

    expect(result).toEqual(new Set(["meta_ads_system_user", "github_token"]));
  });

  it("drops the synthetic google_oauth credential when it is not allowlisted", async () => {
    queueDbResults(
      [{ role: "member" }],
      [],
      [],
      [{ id: "token-1" }], // user has OAuth tokens → google_oauth would be granted
    );

    const { resolveUserCredentials } = await import("./permissions.js");
    const { executionContext } = await import("./tool.js");

    const result = await executionContext.run(
      {
        triggeredBy: "U1",
        triggerType: "scheduled_job",
        callingUserId: "U1",
        envAllowlist: ["GITHUB_TOKEN"],
      },
      () => resolveUserCredentials("U1"),
    );

    expect(result.has("google_oauth")).toBe(false);
  });

  it("keeps google_oauth when GOOGLE_OAUTH is allowlisted", async () => {
    queueDbResults([{ role: "member" }], [], [], [{ id: "token-1" }]);

    const { resolveUserCredentials } = await import("./permissions.js");
    const { executionContext } = await import("./tool.js");

    const result = await executionContext.run(
      {
        triggeredBy: "U1",
        triggerType: "scheduled_job",
        callingUserId: "U1",
        envAllowlist: ["GOOGLE_OAUTH"],
      },
      () => resolveUserCredentials("U1"),
    );

    expect(result.has("google_oauth")).toBe(true);
  });

  it("leaves the credential set unchanged when the context has no allowlist", async () => {
    queueDbResults(
      [{ role: "member" }],
      [],
      [
        { id: "c1", name: "tavily_api_key", scope: "member", ownerId: "U_X", sandboxEnvName: null },
      ],
      [],
    );

    const { resolveUserCredentials } = await import("./permissions.js");
    const { executionContext } = await import("./tool.js");

    const result = await executionContext.run(
      { triggeredBy: "U1", triggerType: "scheduled_job", callingUserId: "U1" },
      () => resolveUserCredentials("U1"),
    );

    expect(result.has("tavily_api_key")).toBe(true);
  });

  it("fails closed and logs for unknown credential scopes", async () => {
    queueDbResults(
      [],
      [],
      [
        {
          id: "cred-1",
          name: "github_token",
          scope: "typo_scope",
          ownerId: "U_OWNER",
        },
      ],
      [],
    );

    const { resolveUserCredentials } = await import("./permissions.js");
    const result = await resolveUserCredentials("U_OWNER");

    expect(result.has("github_token")).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "resolveUserCredentials: unknown credential scope",
      expect.objectContaining({
        credentialName: "github_token",
        scope: "typo_scope",
      }),
    );
  });
});

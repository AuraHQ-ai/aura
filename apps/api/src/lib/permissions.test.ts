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

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  credentialRows: [] as Array<{
    id: string;
    name: string;
    value: string;
    ownerId: string;
    scope: string;
    sandboxEnvName: string | null;
  }>,
  grantRows: [] as Array<{ credentialId: string }>,
}));

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  decryptCredential: vi.fn((value: string) => `decrypted:${value}`),
  resolveUserCredentials: vi.fn(),
}));

vi.mock("../db/client.js", () => {
  mocks.dbSelect.mockImplementation((selection: Record<string, unknown>) => {
    const keys = Object.keys(selection ?? {});
    return {
      from: vi.fn(() => {
        if (keys.length === 1 && keys[0] === "credentialId") {
          return { where: vi.fn(async () => mockState.grantRows) };
        }
        return Promise.resolve(mockState.credentialRows);
      }),
    };
  });

  return {
    db: {
      select: mocks.dbSelect,
    },
  };
});

vi.mock("./credentials.js", () => ({
  decryptCredential: mocks.decryptCredential,
}));

vi.mock("./permissions.js", () => ({
  resolveUserCredentials: mocks.resolveUserCredentials,
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

import { getSandboxEnvNames } from "./sandbox.js";

describe("getSandboxEnvNames", () => {
  beforeEach(() => {
    mockState.credentialRows = [];
    mockState.grantRows = [];
    mocks.dbSelect.mockClear();
    mocks.decryptCredential.mockClear();
    mocks.resolveUserCredentials.mockReset();
    mocks.resolveUserCredentials.mockResolvedValue(new Set<string>());
  });

  it("applies the owner-scoped gate for owned, granted, and ungranted credentials", async () => {
    mockState.credentialRows = [
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
    mockState.grantRows = [{ credentialId: "granted" }];
    mocks.resolveUserCredentials.mockResolvedValue(
      new Set(["github_token", "notion_api_key", "linear_api_key"]),
    );

    await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([
      "GITHUB_TOKEN",
      "NOTION_API_KEY",
    ]);
  });

  it("honors Gate 1 for per_user-scoped credentials with and without grants", async () => {
    mockState.credentialRows = [
      {
        id: "per-user",
        name: "notion_api_key",
        value: "notion-secret-value",
        ownerId: "U_OWNER",
        scope: "per_user",
        sandboxEnvName: "NOTION_API_KEY",
      },
    ];

    mocks.resolveUserCredentials.mockResolvedValue(new Set<string>());
    await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([]);

    mocks.dbSelect.mockClear();
    mockState.grantRows = [{ credentialId: "per-user" }];
    mocks.resolveUserCredentials.mockResolvedValue(new Set(["notion_api_key"]));

    await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([
      "NOTION_API_KEY",
    ]);
  });

  it("honors resolved role-tier credential access and falls back to uppercase names", async () => {
    mockState.credentialRows = [
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
    mocks.resolveUserCredentials.mockResolvedValue(
      new Set(["member_token", "power_token"]),
    );

    await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([
      "MEMBER_TOKEN",
      "POWER_TOKEN",
    ]);
  });

  it("does not select or decrypt credential values", async () => {
    mockState.credentialRows = [
      {
        id: "secret",
        name: "secret_token",
        value: "super-secret-value",
        ownerId: "U_CALLER",
        scope: "owner",
        sandboxEnvName: "SECRET_TOKEN",
      },
    ];
    mocks.resolveUserCredentials.mockResolvedValue(new Set(["secret_token"]));

    await expect(getSandboxEnvNames("U_CALLER")).resolves.toEqual([
      "SECRET_TOKEN",
    ]);

    const selectedValue = mocks.dbSelect.mock.calls.some(([selection]) =>
      Object.keys(selection ?? {}).includes("value"),
    );
    expect(selectedValue).toBe(false);
    expect(mocks.decryptCredential).not.toHaveBeenCalled();
  });
});

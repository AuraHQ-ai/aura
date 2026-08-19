import { describe, it, expect, vi } from "vitest";
import { isSecretSettingKey, redactSettingValue, MASKED_VALUE } from "./settings-redaction.js";

describe("isSecretSettingKey", () => {
  it("matches keys containing 'secret'", () => {
    expect(isSecretSettingKey("elevenlabs_webhook_secret")).toBe(true);
    expect(isSecretSettingKey("my_secret")).toBe(true);
    expect(isSecretSettingKey("SECRET_VALUE")).toBe(true);
  });

  it("matches keys containing 'token'", () => {
    expect(isSecretSettingKey("slack_bot_token")).toBe(true);
    expect(isSecretSettingKey("TOKEN")).toBe(true);
  });

  it("matches keys containing 'password'", () => {
    expect(isSecretSettingKey("db_password")).toBe(true);
    expect(isSecretSettingKey("PASSWORD")).toBe(true);
  });

  it("matches keys containing 'api_key'", () => {
    expect(isSecretSettingKey("openai_api_key")).toBe(true);
    expect(isSecretSettingKey("API_KEY")).toBe(true);
  });

  it("matches keys containing 'apikey'", () => {
    expect(isSecretSettingKey("stripe_apikey")).toBe(true);
    expect(isSecretSettingKey("APIKEY")).toBe(true);
  });

  it("matches keys containing 'private_key'", () => {
    expect(isSecretSettingKey("rsa_private_key")).toBe(true);
    expect(isSecretSettingKey("PRIVATE_KEY")).toBe(true);
  });

  it("matches keys containing 'refresh_token'", () => {
    expect(isSecretSettingKey("google_refresh_token")).toBe(true);
    expect(isSecretSettingKey("REFRESH_TOKEN")).toBe(true);
  });

  it("matches keys containing 'credential'", () => {
    expect(isSecretSettingKey("google_credential")).toBe(true);
    expect(isSecretSettingKey("CREDENTIALS")).toBe(true);
  });

  it("matches keys containing 'webhook_secret'", () => {
    expect(isSecretSettingKey("github_webhook_secret")).toBe(true);
  });

  it("matches keys containing 'signing'", () => {
    expect(isSecretSettingKey("slack_signing_secret")).toBe(true);
    expect(isSecretSettingKey("SIGNING_KEY")).toBe(true);
  });

  it("matches keys starting with 'credential:'", () => {
    expect(isSecretSettingKey("credential:user123:google")).toBe(true);
    expect(isSecretSettingKey("credential:some_key")).toBe(true);
  });

  it("does not match harmless keys", () => {
    expect(isSecretSettingKey("model_main")).toBe(false);
    expect(isSecretSettingKey("theme")).toBe(false);
    expect(isSecretSettingKey("e2b_sandbox_id:abc")).toBe(false);
    expect(isSecretSettingKey("slack_channel")).toBe(false);
    expect(isSecretSettingKey("feature_flag")).toBe(false);
    // Ops-notice routing keys are configuration, not secrets — they must stay
    // readable (view + edit) in the dashboard.
    expect(isSecretSettingKey("aura_ops_channel")).toBe(false);
    expect(isSecretSettingKey("founder_user_id")).toBe(false);
  });
});

describe("redactSettingValue", () => {
  const baseSetting = {
    key: "some_key",
    value: "actual-value",
    description: null,
    updatedAt: new Date("2024-01-01"),
    updatedBy: "dashboard",
    workspaceId: "ws1",
  };

  it("does not redact non-secret keys", () => {
    const result = redactSettingValue({ ...baseSetting, key: "model_main", value: "claude-3" });
    expect(result.value).toBe("claude-3");
    expect(result.redacted).toBe(false);
    expect(result.hasValue).toBe(true);
  });

  it("redacts secret keys and replaces value with masked placeholder", () => {
    const result = redactSettingValue({ ...baseSetting, key: "google_refresh_token", value: "secret123" });
    expect(result.value).toBe(MASKED_VALUE);
    expect(result.redacted).toBe(true);
    expect(result.hasValue).toBe(true);
  });

  it("sets hasValue=false for secret keys with empty stored value", () => {
    const result = redactSettingValue({ ...baseSetting, key: "elevenlabs_webhook_secret", value: "" });
    expect(result.value).toBe(MASKED_VALUE);
    expect(result.redacted).toBe(true);
    expect(result.hasValue).toBe(false);
  });

  it("does not mutate the original object", () => {
    const original = { ...baseSetting, key: "api_key", value: "real-key" };
    redactSettingValue(original);
    expect(original.value).toBe("real-key");
  });
});

// --- GET route integration-style tests ---

vi.mock("../db/client.js", () => ({ db: {} }));

const { dashboardSettingsApp } = await import("../routes/dashboard/settings.js");

function makeDbSetting(overrides: Partial<{
  key: string; value: string; description: string | null;
  updatedAt: Date; updatedBy: string | null; workspaceId: string;
}> = {}) {
  return {
    key: "some_key",
    value: "some_value",
    description: null,
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    updatedBy: "dashboard",
    workspaceId: "ws1",
    ...overrides,
  };
}

// Mock Drizzle builder for the list endpoint
function mockDb(rows: ReturnType<typeof makeDbSetting>[]) {
  const query: any = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => Promise.resolve(rows)),
    limit: vi.fn(() => Promise.resolve(rows.slice(0, 1))),
  };
  return { select: vi.fn(() => query), insert: vi.fn(), query };
}

describe("GET /api/dashboard/settings — redaction in list endpoint", () => {
  it("returns raw value for non-secret keys", async () => {
    const { db } = await import("../db/client.js");
    const mock = mockDb([makeDbSetting({ key: "model_main", value: "claude-3" })]);
    Object.assign(db, mock);

    const res = await dashboardSettingsApp.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body[0].value).toBe("claude-3");
    expect(body[0].redacted).toBe(false);
  });

  it("masks value for secret key in list response", async () => {
    const { db } = await import("../db/client.js");
    const mock = mockDb([makeDbSetting({ key: "google_refresh_token", value: "real-secret" })]);
    Object.assign(db, mock);

    const res = await dashboardSettingsApp.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body[0].value).toBe(MASKED_VALUE);
    expect(body[0].redacted).toBe(true);
    expect(body[0].hasValue).toBe(true);
  });

  it("sets hasValue=false for secret key with empty stored value", async () => {
    const { db } = await import("../db/client.js");
    const mock = mockDb([makeDbSetting({ key: "elevenlabs_webhook_secret", value: "" })]);
    Object.assign(db, mock);

    const res = await dashboardSettingsApp.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body[0].redacted).toBe(true);
    expect(body[0].hasValue).toBe(false);
  });
});

describe("PUT /api/dashboard/settings/:key — write-only semantics", () => {
  it("returns 204 (no-op) when empty value submitted for secret key", async () => {
    const res = await dashboardSettingsApp.request("/google_refresh_token", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "" }),
    });
    expect(res.status).toBe(204);
  });

  it("returns 204 (no-op) when masked placeholder submitted for secret key", async () => {
    const res = await dashboardSettingsApp.request("/google_refresh_token", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: MASKED_VALUE }),
    });
    expect(res.status).toBe(204);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  default: {
    resolve4: vi.fn(async () => ["93.184.216.34"]),
  },
}));

vi.mock("../lib/tool.js", () => ({
  defineTool: (config: any) => config,
}));

vi.mock("../lib/api-credentials.js", () => ({
  getApiCredentialWithType: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { createHttpRequestTool } from "./http-request.js";

function createResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: vi.fn(async () => ({ ok: true })),
    text: vi.fn(async () => ""),
  };
}

describe("http_request body serialization", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => createResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  function getLastFetchInit(): RequestInit {
    const lastCall = fetchMock.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    return lastCall![1] as RequestInit;
  }

  function getTool() {
    return createHttpRequestTool().http_request as any;
  }

  it("serializes object bodies once", async () => {
    const tool = getTool();

    await tool.execute({
      method: "POST",
      url: "https://example.com/api",
      body: { hello: "world" },
      timeout_ms: 30_000,
    });

    const init = getLastFetchInit();
    expect(init.body).toBe('{"hello":"world"}');
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("sends string bodies verbatim", async () => {
    const tool = getTool();

    await tool.execute({
      method: "POST",
      url: "https://example.com/api",
      body: '{"hello":"world"}',
      timeout_ms: 30_000,
    });

    const init = getLastFetchInit();
    expect(init.body).toBe('{"hello":"world"}');
    expect(init.body).not.toBe(JSON.stringify('{"hello":"world"}'));
    expect(init.headers).not.toHaveProperty("Content-Type");
  });

  it("omits the fetch body when no body is provided", async () => {
    const tool = getTool();

    await tool.execute({
      method: "POST",
      url: "https://example.com/api",
      timeout_ms: 30_000,
    });

    const init = getLastFetchInit();
    expect(init.body).toBeUndefined();
  });
});

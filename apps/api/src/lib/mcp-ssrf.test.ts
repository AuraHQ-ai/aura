import { afterEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

import {
  assertPublicHttpsUrl,
  assertPublicHttpsUrlFollowingRedirects,
  McpSsrfError,
} from "./mcp-ssrf.js";

describe("assertPublicHttpsUrl", () => {
  afterEach(() => {
    lookupMock.mockReset();
  });

  it("rejects http, file, and unparseable URLs", async () => {
    await expect(assertPublicHttpsUrl("http://example.com/mcp")).rejects.toThrow(/must use https/);
    await expect(assertPublicHttpsUrl("file:///etc/passwd")).rejects.toThrow(/must use https/);
    await expect(assertPublicHttpsUrl("not a url")).rejects.toThrow(/Invalid MCP URL/);
  });

  it("rejects localhost, loopback, and link-local hostnames without DNS", async () => {
    await expect(assertPublicHttpsUrl("https://localhost/mcp")).rejects.toThrow(McpSsrfError);
    await expect(assertPublicHttpsUrl("https://127.0.0.1/mcp")).rejects.toThrow(/private/);
    await expect(assertPublicHttpsUrl("https://169.254.169.254/latest")).rejects.toThrow(/private/);
  });

  it("rejects a public hostname that resolves to a private address", async () => {
    lookupMock.mockResolvedValue({ address: "10.1.2.3", family: 4 });
    await expect(assertPublicHttpsUrl("https://evil.example/mcp")).rejects.toThrow(/private/);
  });

  it("allows a public https URL", async () => {
    lookupMock.mockResolvedValue({ address: "1.2.3.4", family: 4 });
    const parsed = await assertPublicHttpsUrl("https://mcp.stripe.com/mcp");
    expect(parsed.hostname).toBe("mcp.stripe.com");
  });
});

describe("assertPublicHttpsUrlFollowingRedirects", () => {
  afterEach(() => {
    lookupMock.mockReset();
  });

  it("blocks a redirect hop that lands on a private address", async () => {
    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === "mcp.example.com") return { address: "1.2.3.4", family: 4 };
      if (hostname === "169.254.169.254") return { address: "169.254.169.254", family: 4 };
      return { address: "8.8.8.8", family: 4 };
    });

    const fetchFn = vi.fn(async () => ({
      status: 302,
      headers: {
        get: (name: string) => (name === "location" ? "https://169.254.169.254/meta" : null),
      },
    }));

    await expect(
      assertPublicHttpsUrlFollowingRedirects("https://mcp.example.com/mcp", fetchFn),
    ).rejects.toThrow(/private/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("follows a safe redirect and returns the final public URL", async () => {
    lookupMock.mockResolvedValue({ address: "1.2.3.4", family: 4 });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        status: 301,
        headers: {
          get: (name: string) => (name === "location" ? "https://mcp.example.com/v2" : null),
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { get: () => null },
      });

    const finalUrl = await assertPublicHttpsUrlFollowingRedirects(
      "https://mcp.example.com/mcp",
      fetchFn,
    );
    expect(finalUrl.href).toBe("https://mcp.example.com/v2");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

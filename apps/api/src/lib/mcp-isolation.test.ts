import { describe, expect, it } from "vitest";
import { loadIsolated, settleWithTimeout } from "./mcp-isolation.js";

describe("MCP failure isolation", () => {
  it("returns the error instead of throwing when work rejects", async () => {
    const result = await settleWithTimeout(async () => {
      throw new Error("server down");
    });
    expect(result).toEqual({ ok: false, error: "server down" });
  });

  it("times out a hung server without rejecting the caller", async () => {
    const result = await settleWithTimeout(
      () => new Promise((resolve) => setTimeout(resolve, 200)),
      20,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out/);
  });

  it("keeps tools from healthy servers when one server fails or times out", async () => {
    const servers = [
      { slug: "stripe", delay: 0, fail: false },
      { slug: "dead", delay: 0, fail: true },
      { slug: "hung", delay: 80, fail: false },
      { slug: "linear", delay: 0, fail: false },
    ];

    const { results, failures } = await loadIsolated(
      servers,
      async (server) => {
        if (server.fail) throw new Error(`${server.slug} unreachable`);
        if (server.delay) await new Promise((r) => setTimeout(r, server.delay));
        return { [`mcp__${server.slug}__ping`]: { description: "ok" } };
      },
      (server) => server.slug,
      30,
    );

    expect(results.map((r) => r.id).sort()).toEqual(["linear", "stripe"]);
    expect(Object.keys(results.find((r) => r.id === "stripe")!.value)).toEqual([
      "mcp__stripe__ping",
    ]);
    expect(failures.map((f) => f.id).sort()).toEqual(["dead", "hung"]);
    expect(failures.find((f) => f.id === "dead")?.error).toMatch(/unreachable/);
    expect(failures.find((f) => f.id === "hung")?.error).toMatch(/timed out/);
  });
});

import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ setArg: undefined as any, rows: [] as any[] }));

vi.mock("../db/client.js", () => {
  const q: any = {
    set: vi.fn((s: any) => { state.setArg = s; return q; }),
    where: vi.fn(() => q),
    returning: vi.fn(() => Promise.resolve(state.rows)),
  };
  return { db: { update: vi.fn(() => q) } };
});
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { selfHealTerminalRecurringJobs } from "./recurring-self-heal.js";

describe("selfHealTerminalRecurringJobs", () => {
  it("resets terminal recurring jobs to pending and returns the count", async () => {
    state.rows = [{ id: "a", name: "hacker-news-scan" }, { id: "b", name: "x" }];
    await expect(selfHealTerminalRecurringJobs()).resolves.toBe(2);
    expect(state.setArg).toMatchObject({ status: "pending", executeAt: null });
  });

  it("returns 0 when nothing is stuck", async () => {
    state.rows = [];
    await expect(selfHealTerminalRecurringJobs()).resolves.toBe(0);
  });
});

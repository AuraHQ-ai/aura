import { describe, expect, it, vi } from "vitest";

vi.mock("../../db/client.js", () => ({ db: {} }));

const { updateJobBodySchema } = await import("./jobs.js");

describe("updateJobBodySchema (PATCH /api/dashboard/jobs/:id)", () => {
  it("accepts an empty body (no-op update)", () => {
    expect(updateJobBodySchema.safeParse({}).success).toBe(true);
  });

  it("accepts enabled toggles", () => {
    expect(updateJobBodySchema.safeParse({ enabled: true }).success).toBe(true);
    expect(updateJobBodySchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it("accepts every job-eligible model category and null", () => {
    for (const model of ["main", "fast", "medium", "escalation", null]) {
      const result = updateJobBodySchema.safeParse({ model });
      expect(result.success).toBe(true);
    }
  });

  it("rejects model categories outside the job-eligible catalog list", () => {
    expect(updateJobBodySchema.safeParse({ model: "embedding" }).success).toBe(false);
    expect(updateJobBodySchema.safeParse({ model: "gpt-4" }).success).toBe(false);
    expect(updateJobBodySchema.safeParse({ model: "" }).success).toBe(false);
  });

  it("accepts env allowlists of valid env var names, empty array, and null", () => {
    expect(
      updateJobBodySchema.safeParse({ envAllowlist: ["GITHUB_TOKEN", "_PRIVATE", "lower_case1"] })
        .success,
    ).toBe(true);
    expect(updateJobBodySchema.safeParse({ envAllowlist: [] }).success).toBe(true);
    expect(updateJobBodySchema.safeParse({ envAllowlist: null }).success).toBe(true);
  });

  it("rejects invalid env var names", () => {
    expect(updateJobBodySchema.safeParse({ envAllowlist: ["1BAD"] }).success).toBe(false);
    expect(updateJobBodySchema.safeParse({ envAllowlist: ["HAS SPACE"] }).success).toBe(false);
    expect(updateJobBodySchema.safeParse({ envAllowlist: ["DASH-ED"] }).success).toBe(false);
    expect(updateJobBodySchema.safeParse({ envAllowlist: [""] }).success).toBe(false);
    expect(updateJobBodySchema.safeParse({ envAllowlist: ["KEY=value"] }).success).toBe(false);
  });

  it("accepts prompt modes full, task, and null", () => {
    for (const promptMode of ["full", "task", null]) {
      expect(updateJobBodySchema.safeParse({ promptMode }).success).toBe(true);
    }
  });

  it("rejects unknown prompt modes", () => {
    expect(updateJobBodySchema.safeParse({ promptMode: "minimal" }).success).toBe(false);
  });

  it("distinguishes omitted fields (undefined) from explicit null", () => {
    const omitted = updateJobBodySchema.parse({});
    expect("model" in omitted && omitted.model !== undefined).toBe(false);

    const cleared = updateJobBodySchema.parse({ model: null, envAllowlist: null, promptMode: null });
    expect(cleared.model).toBeNull();
    expect(cleared.envAllowlist).toBeNull();
    expect(cleared.promptMode).toBeNull();
  });
});

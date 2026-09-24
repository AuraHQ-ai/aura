import { describe, expect, it, vi } from "vitest";
import { asSchema } from "ai";
import { z } from "zod";

vi.mock("../db/client.js", () => {
  const chain = () => {
    const q: any = {
      from: vi.fn(() => q),
      where: vi.fn(() => q),
      orderBy: vi.fn(() => q),
      limit: vi.fn(async () => []),
      set: vi.fn(() => q),
      values: vi.fn(() => q),
      returning: vi.fn(async () => [{ id: "log-1" }]),
      onConflictDoUpdate: vi.fn(async () => undefined),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
    };
    return q;
  };
  return {
    db: {
      select: vi.fn(() => chain()),
      insert: vi.fn(() => chain()),
      update: vi.fn(() => chain()),
      delete: vi.fn(() => chain()),
    },
  };
});

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../lib/permissions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/permissions.js")>();
  return {
    ...actual,
    hasRole: async () => true,
    resolveUserCredentials: async () =>
      new Set([
        "admin_access",
        "browserbase_api_key",
        "cursor_api_key",
        "e2b_api_key",
        "elevenlabs_api_key",
        "google_bq_credentials",
        "google_oauth",
        "tavily_api_key",
        "twilio_credentials",
      ]),
  };
});

import { createCoreTools } from "./core.js";
import { createSlackTools } from "./slack.js";

/**
 * Provider strict-mode (AI SDK BaseFunctionTool.strict) rejects a schema
 * unless `required` is an array that includes every key in `properties`.
 * Recurse into nested objects / arrays / combinators so a nested optional
 * field can't hide behind a strict-looking parent.
 */
function strictSchemaFailures(schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as Record<string, unknown>;
  const failures: string[] = [];

  if (s.properties && typeof s.properties === "object") {
    const keys = Object.keys(s.properties as object);
    const required = Array.isArray(s.required)
      ? (s.required as unknown[]).map(String)
      : [];
    const missing = keys.filter((key) => !required.includes(key));
    if (missing.length > 0) {
      failures.push(
        `${path}: 'required' must include every properties key; missing [${missing.join(", ")}]`,
      );
    }
    for (const [key, value] of Object.entries(
      s.properties as Record<string, unknown>,
    )) {
      failures.push(...strictSchemaFailures(value, `${path}.properties.${key}`));
    }
  }

  if (s.items) {
    if (Array.isArray(s.items)) {
      s.items.forEach((item, i) => {
        failures.push(...strictSchemaFailures(item, `${path}.items[${i}]`));
      });
    } else {
      failures.push(...strictSchemaFailures(s.items, `${path}.items`));
    }
  }

  for (const combinator of ["anyOf", "oneOf", "allOf"] as const) {
    const list = s[combinator];
    if (Array.isArray(list)) {
      list.forEach((item, i) => {
        failures.push(
          ...strictSchemaFailures(item, `${path}.${combinator}[${i}]`),
        );
      });
    }
  }

  if (s.additionalProperties && typeof s.additionalProperties === "object") {
    failures.push(
      ...strictSchemaFailures(
        s.additionalProperties,
        `${path}.additionalProperties`,
      ),
    );
  }

  return failures;
}

async function toolJsonSchema(inputSchema: unknown): Promise<unknown> {
  return await asSchema(inputSchema as never).jsonSchema;
}

describe("registered tool JSON schemas vs strict mode", () => {
  it("treats optional properties as strict-incompatible (the #1517 failure mode)", async () => {
    const jsonSchema = await toolJsonSchema(
      z.object({
        topic: z.string(),
        summary: z.string().optional(),
      }),
    );
    const failures = strictSchemaFailures(jsonSchema, "save_note");
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join("\n")).toMatch(/summary/);
  });

  it("every registered tool is strict-valid or carries strict: false", async () => {
    const fakeClient = {
      conversations: { history: vi.fn() },
    } as any;

    const coreTools = await createCoreTools(
      { userId: "U_TEST", channelId: "C_TEST" },
      undefined,
      undefined,
    );
    const slackTools = await createSlackTools(fakeClient, {
      userId: "U_TEST",
      channelId: "C_TEST",
    });
    const tools = { ...coreTools, ...slackTools };

    expect(Object.keys(tools).length).toBeGreaterThan(50);
    expect(tools).toHaveProperty("save_note");
    expect(tools).toHaveProperty("get_current_datetime");
    // save_note is the first tool the job flow hits (#1517); it has optional
    // params, so the defineTool default must land as strict: false.
    expect((tools.save_note as { strict?: boolean }).strict).toBe(false);
    expect(
      (tools.get_current_datetime as { strict?: boolean }).strict,
    ).toBe(false);

    const offenders: string[] = [];
    for (const [name, t] of Object.entries(tools)) {
      const tool = t as {
        strict?: boolean;
        inputSchema?: unknown;
        execute?: unknown;
      };
      if (!tool || typeof tool.execute !== "function" || !tool.inputSchema) {
        continue;
      }
      if (tool.strict === false) continue;

      const jsonSchema = await toolJsonSchema(tool.inputSchema);
      const failures = strictSchemaFailures(jsonSchema, name);
      if (failures.length > 0) {
        offenders.push(`${name}: ${failures.join("; ")}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

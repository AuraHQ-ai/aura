import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  augmentBigQueryErrorMessage,
  getBigQueryErrorHints,
} from "../lib/bigquery-errors.js";

const queryMock = vi.fn();
const getMetadataMock = vi.fn();

vi.mock("../db/client.js", () => ({
  db: {},
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../lib/bigquery.js", () => ({
  getBigQueryClient: vi.fn(async () => ({
    query: queryMock,
    dataset: vi.fn(() => ({
      getMetadata: getMetadataMock,
      table: vi.fn(() => ({
        getMetadata: getMetadataMock,
      })),
    })),
  })),
}));

class BigLikeNumeric {
  constructor(private readonly value: string) {}

  toJSON() {
    return this.value;
  }

  plus() {
    return this;
  }
}

beforeEach(() => {
  queryMock.mockReset();
  getMetadataMock.mockReset();
});

describe("BigQuery error hint augmentation", () => {
  it("adds access-denied guidance for permission-style errors", () => {
    const message =
      "Access Denied: Table project.dataset.table: User does not have permission to query table.";
    const hints = getBigQueryErrorHints(message);

    expect(hints.length).toBeGreaterThan(0);
    expect(hints.join("\n")).toContain("does not automatically mean IAM is wrong");
    expect(hints.join("\n")).toContain("SELECT COUNT(*)");
  });

  it("adds syntax guidance for parse errors", () => {
    const message = "Syntax error: Unexpected keyword FROM at [3:10]";
    const hints = getBigQueryErrorHints(message);

    expect(hints.length).toBeGreaterThan(0);
    expect(hints.join("\n")).toContain("BigQuery uses Standard SQL");
    expect(hints.join("\n")).toContain("dataset.table");
  });

  it("adds dataset/location recovery ladder guidance", () => {
    const message =
      "Not found: Dataset some-project:analytics was not found in location EU";
    const hints = getBigQueryErrorHints(message);

    expect(hints.length).toBeGreaterThan(0);
    expect(hints.join("\n")).toContain("bq_list_datasets");
    expect(hints.join("\n")).toContain("bq_inspect_table");
  });

  it("includes multiple hints when multiple patterns match", () => {
    const message =
      "Access Denied: Syntax error: Unexpected identifier. Not found: Dataset analytics was not found.";
    const augmented = augmentBigQueryErrorMessage(message);

    expect(augmented).toContain("Debug hints:");
    expect(augmented).toContain("IAM");
    expect(augmented).toContain("Standard SQL");
    expect(augmented).toContain("bq_list_datasets");
  });

  it("returns unchanged message when no known pattern matches", () => {
    const message = "Job aborted due to unknown transient networking error.";
    const augmented = augmentBigQueryErrorMessage(message);

    expect(augmented).toBe(message);
  });
});

describe("BigQuery row sanitization", () => {
  it("returns structured-cloneable rows from bq_execute_query", async () => {
    const numericValue = new BigLikeNumeric("1.23");
    expect(() => structuredClone(numericValue)).toThrow();
    queryMock.mockResolvedValueOnce([
      [{ x: numericValue }],
      undefined,
      { schema: { fields: [{ name: "x" }] }, totalBytesProcessed: "0" },
    ]);

    const { createBigQueryTools } = await import("./bigquery.js");
    const tools = createBigQueryTools();
    const result = await (tools.bq_execute_query as any).execute({
      sql: "SELECT CAST(1.23 AS NUMERIC) AS x",
      max_rows: 10,
    });

    expect(result).toMatchObject({
      ok: true,
      columns: ["x"],
      rows: [{ x: "1.23" }],
      total_rows: 1,
    });
    expect(() => structuredClone(result)).not.toThrow();
  });
});

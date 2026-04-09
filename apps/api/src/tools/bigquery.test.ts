import { describe, expect, it } from "vitest";
import {
  augmentBigQueryErrorMessage,
  getBigQueryErrorHints,
} from "../lib/bigquery-errors.js";

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
    expect(hints.join("\n")).toContain("list_bigquery_datasets");
    expect(hints.join("\n")).toContain("inspect_bigquery_table");
  });

  it("includes multiple hints when multiple patterns match", () => {
    const message =
      "Access Denied: Syntax error: Unexpected identifier. Not found: Dataset analytics was not found.";
    const augmented = augmentBigQueryErrorMessage(message);

    expect(augmented).toContain("Debug hints:");
    expect(augmented).toContain("IAM");
    expect(augmented).toContain("Standard SQL");
    expect(augmented).toContain("list_bigquery_datasets");
  });

  it("returns unchanged message when no known pattern matches", () => {
    const message = "Job aborted due to unknown transient networking error.";
    const augmented = augmentBigQueryErrorMessage(message);

    expect(augmented).toBe(message);
  });
});

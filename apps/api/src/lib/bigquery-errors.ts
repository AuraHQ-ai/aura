const ACCESS_DENIED_PATTERNS = [
  /access denied/i,
  /permission denied/i,
  /insufficient permissions?/i,
  /does not have .* permission/i,
  /not have .* permission/i,
  /missing .* permission/i,
];

const SYNTAX_ERROR_PATTERNS = [
  /syntax error/i,
  /parse error/i,
  /unexpected/i,
  /expected/i,
  /unrecognized name/i,
];

const DATASET_OR_LOCATION_PATTERNS = [
  /not found: dataset/i,
  /dataset .* was not found/i,
  /not found: table/i,
  /table .* was not found/i,
  /must be qualified with a dataset/i,
  /not found in location/i,
  /cannot read and write in different locations/i,
];

/**
 * Lightweight pattern-based BigQuery error hints to reduce bad recovery loops.
 */
export function getBigQueryErrorHints(errorMessage: string): string[] {
  const hints: string[] = [];

  if (ACCESS_DENIED_PATTERNS.some((pattern) => pattern.test(errorMessage))) {
    hints.push(
      "Access Denied from a complex query does not automatically mean IAM is wrong. Verify table references first (`FROM dataset.table` or ``FROM `project.dataset.table` ``), then retry the smallest valid query (`SELECT COUNT(*) FROM dataset.table`).",
    );
  }

  if (SYNTAX_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))) {
    hints.push(
      "BigQuery uses Standard SQL (`useLegacySql: false`). Use valid table references (`FROM dataset.table` or ``FROM `project.dataset.table` ``) and keep one qualification style while debugging.",
    );
  }

  if (DATASET_OR_LOCATION_PATTERNS.some((pattern) => pattern.test(errorMessage))) {
    hints.push(
      "Use explicit table references (`dataset.table` or ``project.dataset.table``) and restart the recovery ladder: bq_list_datasets -> bq_list_tables -> bq_inspect_table -> SELECT COUNT(*) -> SELECT * LIMIT 5.",
    );
  }

  return hints;
}

export function augmentBigQueryErrorMessage(errorMessage: string): string {
  const hints = getBigQueryErrorHints(errorMessage);
  if (hints.length === 0) return errorMessage;
  return `${errorMessage}\n\nDebug hints:\n${hints.map((hint) => `- ${hint}`).join("\n")}`;
}

import { z } from "zod";
import { logger } from "../lib/logger.js";
import { formatTimestamp } from "../lib/temporal.js";
import { getBigQueryClient } from "../lib/bigquery.js";
import {
  augmentBigQueryErrorMessage,
} from "../lib/bigquery-errors.js";
import { defineTool } from "../lib/tool.js";
import type { ScheduleContext } from "@aura/db/schema";

/**
 * Strip leading SQL comments (line -- and block comments) and whitespace
 * so the first real token can be inspected.
 */
function stripLeadingComments(sql: string): string {
  let s = sql;
  while (true) {
    s = s.replace(/^\s+/, "");
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1);
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2);
    } else {
      break;
    }
  }
  return s;
}

/**
 * Validate that a SQL string is a read-only SELECT query.
 * Returns an error message if the query is not allowed, or null if OK.
 */
function validateReadOnlySQL(sql: string): string | null {
  // Reject multi-statement scripts (semicolons not inside string literals)
  // Strip string literals first to avoid false positives
  const withoutStrings = sql.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  // Allow a single trailing semicolon (common in normal SQL) before checking
  if (withoutStrings.replace(/;\s*$/, "").includes(";")) {
    return "Multi-statement queries are not allowed. Submit one SELECT at a time.";
  }

  // Strip leading comments to find the real first keyword
  const stripped = stripLeadingComments(sql);
  const firstToken = stripped.match(/^(\w+)/i)?.[1]?.toUpperCase();

  // Allowlist: only SELECT and WITH (CTE) are permitted
  if (firstToken !== "SELECT" && firstToken !== "WITH") {
    return "Only SELECT queries are permitted. DML, DDL, CALL, EXPORT, and other statements are blocked.";
  }

  return null;
}

/**
 * Validate that a string is a safe BigQuery identifier (dataset or table name).
 * Only allows alphanumeric characters, underscores, and hyphens.
 */
const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9_-]+$/;
function isSafeBigQueryIdentifier(id: string): boolean {
  return SAFE_IDENTIFIER_RE.test(id);
}

/** Max result payload size to avoid token bloat. */
const MAX_RESULT_CHARS = 8000;

const BIGQUERY_SQL_STYLE_GUIDANCE =
  "BigQuery Standard SQL only (not legacy SQL). Prefer `FROM dataset.table`; when needed use fully-qualified ``FROM `project.dataset.table` ``. Do not mix qualification styles mid-debug.";
const BIGQUERY_DEBUGGING_LADDER =
  "Debugging ladder: bq_list_datasets -> bq_list_tables -> bq_inspect_table -> SELECT COUNT(*) -> SELECT * LIMIT 5 -> then your real query.";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatBigQueryToolError(prefix: string, error: unknown): string {
  return `${prefix}: ${augmentBigQueryErrorMessage(getErrorMessage(error))}`;
}

/**
 * Extract the first dataset reference from a SQL query so we can resolve its
 * location. Handles backtick-quoted `project.dataset.table`,
 * `dataset.table`, and unquoted dataset.table references after FROM / JOIN.
 * Returns the dataset ID or null if none found.
 */
function extractDatasetFromSQL(sql: string): string | null {
  // Match backtick-quoted references: `project.dataset.table` or `dataset.table`
  const backtickMatch = sql.match(
    /(?:FROM|JOIN)\s+`(?:[a-zA-Z0-9_-]+\.)?([a-zA-Z0-9_-]+)\.[a-zA-Z0-9_-]+`/i,
  );
  if (backtickMatch) return backtickMatch[1];

  // Match unquoted references: project.dataset.table or dataset.table
  const unquotedMatch = sql.match(
    /(?:FROM|JOIN)\s+(?:[a-zA-Z0-9_-]+\.)?([a-zA-Z0-9_-]+)\.[a-zA-Z0-9_-]+/i,
  );
  if (unquotedMatch) return unquotedMatch[1];

  return null;
}

/**
 * Resolve the BigQuery location for a dataset. Returns undefined if the
 * dataset cannot be found (falls back to default location behavior).
 */
async function resolveDatasetLocation(
  client: NonNullable<Awaited<ReturnType<typeof getBigQueryClient>>>,
  datasetId: string,
): Promise<string | undefined> {
  try {
    const [metadata] = await client.dataset(datasetId).getMetadata();
    return metadata.location ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create BigQuery tools for the AI SDK.
 * All tools are read-only. DML/DDL is rejected.
 */
export function createBigQueryTools(context?: ScheduleContext) {
  const listTablesInputSchema = z.object({
    dataset: z.string().describe("The dataset ID to list tables from"),
  });
  const inspectTableInputSchema = z.object({
    dataset: z.string().describe("The dataset ID"),
    table: z.string().describe("The table ID"),
    sample_rows: z
      .number()
      .min(0)
      .max(20)
      .default(5)
      .describe("Number of sample rows to fetch (default 5, max 20)"),
  });
  const executeQueryInputSchema = z.object({
    sql: z
      .string()
      .describe("The SQL query to execute (BigQuery Standard SQL, SELECT/WITH only)"),
    max_rows: z
      .number()
      .min(1)
      .max(1000)
      .default(100)
      .describe("Maximum rows to return (default 100, max 1000)"),
  });

  const executeListBigQueryDatasets = async (toolName: string) => {
    const client = await getBigQueryClient();
    if (!client) {
      return {
        ok: false as const,
        error: "BigQuery is not configured. GOOGLE_BQ_CREDENTIALS is missing.",
      };
    }

    try {
      const [datasets] = await client.getDatasets();
      const result = datasets.map((ds) => ({
        id: ds.id,
        location: ds.metadata?.location ?? null,
        description: ds.metadata?.description ?? null,
      }));

      logger.info(`${toolName} called`, { count: result.length });
      return { ok: true as const, datasets: result };
    } catch (error: unknown) {
      logger.error(`${toolName} failed`, { error: getErrorMessage(error) });
      return {
        ok: false as const,
        error: formatBigQueryToolError("Failed to list datasets", error),
      };
    }
  };

  const executeListBigQueryTables = async (
    { dataset }: z.infer<typeof listTablesInputSchema>,
    toolName: string,
  ) => {
    const client = await getBigQueryClient();
    if (!client) {
      return {
        ok: false as const,
        error: "BigQuery is not configured. GOOGLE_BQ_CREDENTIALS is missing.",
      };
    }

    try {
      const [tables] = await client.dataset(dataset).getTables();
      const result = tables.map((t) => ({
        id: t.id,
        type: t.metadata?.type ?? null,
        description: t.metadata?.description ?? null,
        row_count: t.metadata?.numRows ?? null,
      }));

      logger.info(`${toolName} called`, { dataset, count: result.length });
      return { ok: true as const, dataset, tables: result };
    } catch (error: unknown) {
      logger.error(`${toolName} failed`, { dataset, error: getErrorMessage(error) });
      return {
        ok: false as const,
        error: formatBigQueryToolError(`Failed to list tables in ${dataset}`, error),
      };
    }
  };

  const executeInspectBigQueryTable = async (
    { dataset, table, sample_rows }: z.infer<typeof inspectTableInputSchema>,
    toolName: string,
  ) => {
    const client = await getBigQueryClient();
    if (!client) {
      return {
        ok: false as const,
        error: "BigQuery is not configured. GOOGLE_BQ_CREDENTIALS is missing.",
      };
    }

    if (!isSafeBigQueryIdentifier(dataset) || !isSafeBigQueryIdentifier(table)) {
      return {
        ok: false as const,
        error:
          "Invalid dataset or table name. Only alphanumeric characters, underscores, and hyphens are allowed.",
      };
    }

    try {
      const tableRef = client.dataset(dataset).table(table);
      const [metadata] = await tableRef.getMetadata();

      const schema = (metadata.schema?.fields ?? []).map((f: any) => ({
        name: f.name,
        type: f.type,
        mode: f.mode ?? "NULLABLE",
        description: f.description ?? null,
      }));

      const info = {
        row_count: metadata.numRows ?? null,
        size_bytes: metadata.numBytes ?? null,
        description: metadata.description ?? null,
        created: metadata.creationTime
          ? formatTimestamp(new Date(Number(metadata.creationTime)), context?.timezone)
          : null,
        modified: metadata.lastModifiedTime
          ? formatTimestamp(new Date(Number(metadata.lastModifiedTime)), context?.timezone)
          : null,
      };

      const location: string | undefined = metadata.location ?? undefined;

      let samples: any[] = [];
      if (sample_rows > 0) {
        try {
          const [rows] = await client.query({
            query: `SELECT * FROM \`${dataset}.${table}\` LIMIT ${sample_rows}`,
            useLegacySql: false,
            maximumBytesBilled: String(1e9),
            location,
          });
          samples = JSON.parse(JSON.stringify(rows));
        } catch (sampleError: unknown) {
          logger.warn(`${toolName} sample query failed`, {
            dataset,
            table,
            error: getErrorMessage(sampleError),
          });
        }
      }

      logger.info(`${toolName} called`, {
        dataset,
        table,
        schemaFields: schema.length,
        sampleRows: samples.length,
      });

      const result = {
        ok: true as const,
        dataset,
        table,
        schema,
        ...info,
        sample_rows: samples,
      };

      const serialized = JSON.stringify(result);
      if (serialized.length > MAX_RESULT_CHARS) {
        let truncated = samples.slice();
        let output: typeof result & { _truncated?: boolean; _note?: string };
        do {
          truncated = truncated.slice(0, Math.floor(truncated.length / 2));
          output = {
            ...result,
            sample_rows: truncated,
            _truncated: true,
            _note: `Showing ${truncated.length} of ${samples.length} sample rows to stay within size limits.`,
          };
        } while (
          JSON.stringify(output).length > MAX_RESULT_CHARS &&
          truncated.length > 0
        );
        return output;
      }

      return result;
    } catch (error: unknown) {
      logger.error(`${toolName} failed`, {
        dataset,
        table,
        error: getErrorMessage(error),
      });
      return {
        ok: false as const,
        error: formatBigQueryToolError(`Failed to inspect ${dataset}.${table}`, error),
      };
    }
  };

  const executeBigQueryQuery = async (
    { sql, max_rows }: z.infer<typeof executeQueryInputSchema>,
    toolName: string,
  ) => {
    const client = await getBigQueryClient();
    if (!client) {
      return {
        ok: false as const,
        error: "BigQuery is not configured. GOOGLE_BQ_CREDENTIALS is missing.",
      };
    }

    // Safety: only allow read-only SELECT / WITH queries
    const validationError = validateReadOnlySQL(sql);
    if (validationError) {
      return { ok: false as const, error: validationError };
    }

    // Inject LIMIT if not already present
    const hasLimit = /\bLIMIT\s+\d+/i.test(sql);
    const finalSql = hasLimit ? sql : `${sql.replace(/;\s*$/, "")} LIMIT ${max_rows}`;

    try {
      // Resolve dataset location so the query job runs in the right region
      const datasetId = extractDatasetFromSQL(finalSql);
      const location = datasetId
        ? await resolveDatasetLocation(client, datasetId)
        : undefined;

      const queryResult = await client.query({
        query: finalSql,
        useLegacySql: false,
        maximumBytesBilled: String(1e9),
        maxResults: max_rows,
        location,
      });
      const rows = queryResult[0];
      const cleanRows = JSON.parse(JSON.stringify(rows));
      const responseMeta = (queryResult as any)[2];
      const columns =
        responseMeta?.schema?.fields?.map((f: any) => f.name) ??
        (cleanRows.length > 0 ? Object.keys(cleanRows[0]) : []);
      const totalRows = cleanRows.length;
      const bytesProcessed = responseMeta?.totalBytesProcessed ?? null;

      logger.info(`${toolName} called`, {
        sqlLength: sql.length,
        rowCount: cleanRows.length,
        bytesProcessed,
      });

      const resultRows = cleanRows.slice(0, max_rows);
      const result = {
        ok: true as const,
        columns,
        rows: resultRows,
        total_rows: totalRows,
        bytes_processed: bytesProcessed,
      };

      const serialized = JSON.stringify(result);
      if (serialized.length > MAX_RESULT_CHARS) {
        let truncated = resultRows.slice();
        let output;
        do {
          truncated = truncated.slice(0, Math.floor(truncated.length / 2));
          output = {
            ok: true as const,
            columns,
            rows: truncated,
            total_rows: totalRows,
            bytes_processed: bytesProcessed,
            _truncated: true,
            _note: `Showing ${truncated.length} of ${totalRows} rows. Use a more specific query or smaller LIMIT.`,
          };
        } while (
          JSON.stringify(output).length > MAX_RESULT_CHARS &&
          truncated.length > 0
        );
        return output;
      }

      return result;
    } catch (error: unknown) {
      logger.error(`${toolName} failed`, {
        sql: sql.substring(0, 200),
        error: getErrorMessage(error),
      });
      return {
        ok: false as const,
        error: formatBigQueryToolError("Query failed", error),
      };
    }
  };

  return {
    bq_list_datasets: defineTool({
      requiredCredentials: ["google_bq_credentials"],
      description:
        "List all datasets in BigQuery. This is step 1 of the recovery ladder and the safest reset point when queries fail. Use this before table/query calls so you know the real dataset names and locations. After exploring, save findings to a 'data-warehouse-map' knowledge note for future reference.",
      inputSchema: z.object({}),
      execute: async () => executeListBigQueryDatasets("bq_list_datasets"),
      slack: { status: "Listing datasets...", output: (r) => r.ok === false ? r.error : `${(r.datasets ?? []).length} datasets` },
    }),

    bq_list_tables: defineTool({
      requiredCredentials: ["google_bq_credentials"],
      description:
        "List all tables in a BigQuery dataset, including type, row count, and description. This is step 2 in the recovery ladder after bq_list_datasets.",
      inputSchema: listTablesInputSchema,
      execute: async (input) => executeListBigQueryTables(input, "bq_list_tables"),
      slack: { status: "Listing tables...", detail: (i) => i.dataset, output: (r) => r.ok === false ? r.error : `${(r.tables ?? []).length} tables` },
    }),

    bq_inspect_table: defineTool({
      requiredCredentials: ["google_bq_credentials"],
      description:
        `Get a table's full schema, metadata, and sample rows. This is step 3 of the recovery ladder and should be used before querying any unfamiliar table. ${BIGQUERY_DEBUGGING_LADDER} ${BIGQUERY_SQL_STYLE_GUIDANCE} After exploring, update the 'data-warehouse-map' knowledge note with useful columns, joins, and quirks.`,
      inputSchema: inspectTableInputSchema,
      execute: async (input) => executeInspectBigQueryTable(input, "bq_inspect_table"),
      slack: {
        status: "Inspecting table...",
        detail: (i) => `${i.dataset}.${i.table}`,
        output: (r) => {
          if ("error" in r && typeof r.error === "string") return r.error;
          if ("row_count" in r) return `${r.row_count ?? "?"} rows, ${(r.schema ?? []).length} columns`;
          return undefined;
        },
      },
    }),

    bq_execute_query: defineTool({
      requiredCredentials: ["google_bq_credentials"],
      description:
        `Run a read-only BigQuery query (SELECT/WITH only). ${BIGQUERY_SQL_STYLE_GUIDANCE} ${BIGQUERY_DEBUGGING_LADDER} For unfamiliar tables, bq_inspect_table before querying. Do not infer permissions issues from one complex failing query; retry a minimal valid query first.`,
      inputSchema: executeQueryInputSchema,
      execute: async (input) => executeBigQueryQuery(input, "bq_execute_query"),
      slack: {
        status: "Running a SQL query...",
        detail: (input) =>
          !input.sql ? undefined
            : input.sql.length <= 120
              ? input.sql
              : input.sql.slice(0, 119) + "…",
        output: (result) => {
          if ("error" in result && typeof result.error === "string") return result.error;
          if ("total_rows" in result) return `${result.total_rows ?? 0} rows`;
          return undefined;
        },
      },
    }),
  };
}

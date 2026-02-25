import { tool } from "ai";
import { z } from "zod";
import { logger } from "../lib/logger.js";
import { formatTimestamp } from "../lib/temporal.js";
import { getBigQueryClient } from "../lib/bigquery.js";
import { defineTool } from "../lib/tool.js";
import type { ScheduleContext } from "../db/schema.js";

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
  return {
    list_datasets: tool({
      description:
        "List all datasets in the BigQuery data warehouse. Use this to discover what data is available. After exploring, save findings to a 'data-warehouse-map' knowledge note for future reference.",
      inputSchema: z.object({}),
      execute: async () => {
        const client = await getBigQueryClient();
        if (!client) {
          return {
            ok: false,
            error:
              "BigQuery is not configured. GOOGLE_BQ_CREDENTIALS is missing.",
          };
        }

        try {
          const [datasets] = await client.getDatasets();
          const result = datasets.map((ds) => ({
            id: ds.id,
            location: ds.metadata?.location ?? null,
            description: ds.metadata?.description ?? null,
          }));

          logger.info("list_datasets called", { count: result.length });
          return { ok: true, datasets: result };
        } catch (error: any) {
          logger.error("list_datasets failed", { error: error.message });
          return { ok: false, error: `Failed to list datasets: ${error.message}` };
        }
      },
    }),

    list_tables: tool({
      description:
        "List all tables in a BigQuery dataset, including type, row count, and description.",
      inputSchema: z.object({
        dataset: z.string().describe("The dataset ID to list tables from"),
      }),
      execute: async ({ dataset }) => {
        const client = await getBigQueryClient();
        if (!client) {
          return {
            ok: false,
            error:
              "BigQuery is not configured. GOOGLE_BQ_CREDENTIALS is missing.",
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

          logger.info("list_tables called", { dataset, count: result.length });
          return { ok: true, dataset, tables: result };
        } catch (error: any) {
          logger.error("list_tables failed", { dataset, error: error.message });
          return {
            ok: false,
            error: `Failed to list tables in ${dataset}: ${error.message}`,
          };
        }
      },
    }),

    inspect_table: tool({
      description:
        "Get a table's full schema, metadata, and sample rows. Always use this before querying an unfamiliar table — the sample rows show actual data values, formats, and sparsity, which is much more useful than schema alone. After exploring, update the 'data-warehouse-map' knowledge note with what you learn about datasets, key tables, useful columns, common joins, and data quirks.",
      inputSchema: z.object({
        dataset: z.string().describe("The dataset ID"),
        table: z.string().describe("The table ID"),
        sample_rows: z
          .number()
          .min(0)
          .max(20)
          .default(5)
          .describe("Number of sample rows to fetch (default 5, max 20)"),
      }),
      execute: async ({ dataset, table, sample_rows }) => {
        const client = await getBigQueryClient();
        if (!client) {
          return {
            ok: false,
            error:
              "BigQuery is not configured. GOOGLE_BQ_CREDENTIALS is missing.",
          };
        }

        if (!isSafeBigQueryIdentifier(dataset) || !isSafeBigQueryIdentifier(table)) {
          return {
            ok: false,
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
              samples = rows;
            } catch (sampleError: any) {
              logger.warn("inspect_table sample query failed", {
                dataset,
                table,
                error: sampleError.message,
              });
            }
          }

          logger.info("inspect_table called", {
            dataset,
            table,
            schemaFields: schema.length,
            sampleRows: samples.length,
          });

          const result = {
            ok: true,
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
        } catch (error: any) {
          logger.error("inspect_table failed", {
            dataset,
            table,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to inspect ${dataset}.${table}: ${error.message}`,
          };
        }
      },
    }),

    execute_query: defineTool({
      description:
        "Run a read-only SQL query against BigQuery. Only SELECT/WITH queries are allowed — DML/DDL is blocked. Uses standard SQL (not legacy). Has a 1 GB scan limit to prevent runaway costs. Use LIMIT for large result sets to keep responses manageable. Read the 'data-warehouse-map' note before re-exploring from scratch.",
      inputSchema: z.object({
        sql: z
          .string()
          .describe("The SQL query to execute (SELECT only, standard SQL)"),
        max_rows: z
          .number()
          .min(1)
          .max(1000)
          .default(100)
          .describe("Maximum rows to return (default 100, max 1000)"),
      }),
      execute: async ({ sql, max_rows }) => {
        const client = await getBigQueryClient();
        if (!client) {
          return {
            ok: false,
            error:
              "BigQuery is not configured. GOOGLE_BQ_CREDENTIALS is missing.",
          };
        }

        // Safety: only allow read-only SELECT / WITH queries
        const validationError = validateReadOnlySQL(sql);
        if (validationError) {
          return { ok: false, error: validationError };
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
          const responseMeta = (queryResult as any)[2];
          const columns =
            responseMeta?.schema?.fields?.map((f: any) => f.name) ??
            (rows.length > 0 ? Object.keys(rows[0]) : []);
          const totalRows = rows.length;
          const bytesProcessed = responseMeta?.totalBytesProcessed ?? null;

          logger.info("execute_query called", {
            sqlLength: sql.length,
            rowCount: rows.length,
            bytesProcessed,
          });

          const resultRows = rows.slice(0, max_rows);
          const result = {
            ok: true,
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
                ok: true,
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
        } catch (error: any) {
          logger.error("execute_query failed", {
            sql: sql.substring(0, 200),
            error: error.message,
          });
          return {
            ok: false,
            error: `Query failed: ${error.message}`,
          };
        }
      },
      slack: {
        status: "Running a SQL query...",
        detail: (input) =>
          input.sql.length <= 120
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

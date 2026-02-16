import { tool } from "ai";
import { z } from "zod";
import { logger } from "../lib/logger.js";
import { getBigQueryClient } from "../lib/bigquery.js";

/** DML/DDL keywords that indicate a write operation. */
const WRITE_KEYWORDS =
  /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|MERGE)\b/i;

/** Max result payload size to avoid token bloat. */
const MAX_RESULT_CHARS = 8000;

/**
 * Create BigQuery tools for the AI SDK.
 * All tools are read-only. DML/DDL is rejected.
 */
export function createBigQueryTools() {
  return {
    list_datasets: tool({
      description:
        "List all datasets in the BigQuery data warehouse. Use this to discover what data is available.",
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
        "Get a table's full schema, metadata, and sample rows. Use this before querying an unfamiliar table — the sample rows show actual data values, formats, and sparsity.",
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
              ? new Date(Number(metadata.creationTime)).toISOString()
              : null,
            modified: metadata.lastModifiedTime
              ? new Date(Number(metadata.lastModifiedTime)).toISOString()
              : null,
          };

          let samples: any[] = [];
          if (sample_rows > 0) {
            try {
              const [rows] = await client.query({
                query: `SELECT * FROM \`${dataset}.${table}\` LIMIT ${sample_rows}`,
                useLegacySql: false,
                maximumBytesBilled: String(1e9),
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
            const reducedCount = Math.max(1, Math.floor(samples.length / 2));
            return {
              ...result,
              sample_rows: samples.slice(0, reducedCount),
              _truncated: true,
              _note: `Showing ${reducedCount} of ${samples.length} sample rows to stay within size limits.`,
            };
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

    execute_query: tool({
      description:
        "Run a read-only SQL query against BigQuery. DML/DDL statements are blocked. Uses standard SQL (not legacy). Has a 1 GB scan limit to prevent runaway costs.",
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

        // Safety: reject DML/DDL
        if (WRITE_KEYWORDS.test(sql)) {
          return {
            ok: false,
            error:
              "Write operations are not allowed. Only SELECT queries are permitted.",
          };
        }

        // Inject LIMIT if not already present
        const hasLimit = /\bLIMIT\s+\d+/i.test(sql);
        const finalSql = hasLimit ? sql : `${sql.replace(/;\s*$/, "")} LIMIT ${max_rows}`;

        try {
          const [rows, queryJob] = await client.query({
            query: finalSql,
            useLegacySql: false,
            maximumBytesBilled: String(1e9),
          });

          const jobMeta = (queryJob as any)?.statistics?.query ?? {};
          const columns =
            jobMeta?.schema?.fields?.map((f: any) => f.name) ??
            (rows.length > 0 ? Object.keys(rows[0]) : []);
          const totalRows = rows.length;
          const bytesProcessed = jobMeta?.totalBytesProcessed ?? null;

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
            const reducedCount = Math.max(10, Math.floor(resultRows.length / 2));
            return {
              ok: true,
              columns,
              rows: resultRows.slice(0, reducedCount),
              total_rows: totalRows,
              bytes_processed: bytesProcessed,
              _truncated: true,
              _note: `Showing ${reducedCount} of ${totalRows} rows. Use a more specific query or smaller LIMIT.`,
            };
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
    }),
  };
}

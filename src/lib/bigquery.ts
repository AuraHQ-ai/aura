import { logger } from "./logger.js";

/**
 * Lazy-initialized BigQuery client.
 * Uses dynamic import() per project convention to avoid cold-start overhead
 * on requests that don't use BigQuery.
 *
 * Reads GOOGLE_BQ_CREDENTIALS env var (base64-encoded service account JSON).
 */

let clientPromise: Promise<InstanceType<
  typeof import("@google-cloud/bigquery").BigQuery
> | null> | null = null;

export async function getBigQueryClient() {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const encoded = process.env.GOOGLE_BQ_CREDENTIALS;
    if (!encoded) {
      logger.warn(
        "GOOGLE_BQ_CREDENTIALS not set — BigQuery tools will be unavailable",
      );
      clientPromise = null;
      return null;
    }

    try {
      const json = Buffer.from(encoded, "base64").toString("utf-8");
      const credentials = JSON.parse(json);
      const { BigQuery } = await import("@google-cloud/bigquery");
      const client = new BigQuery({
        credentials,
        projectId: credentials.project_id,
      });
      logger.info("BigQuery client initialized", {
        projectId: credentials.project_id,
      });
      return client;
    } catch (error: any) {
      logger.error("Failed to initialize BigQuery client", {
        error: error.message,
      });
      clientPromise = null;
      return null;
    }
  })();

  return clientPromise;
}

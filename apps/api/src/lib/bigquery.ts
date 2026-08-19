import { logger } from "./logger.js";
import { resolveCredentialValue } from "./credentials.js";

let clientPromise: Promise<InstanceType<
  typeof import("@google-cloud/bigquery").BigQuery
> | null> | null = null;

export async function getBigQueryClient() {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const encoded = await resolveCredentialValue("google_bq_credentials");
    if (!encoded) {
      logger.warn("google_bq_credentials not found — BigQuery tools unavailable");
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

import { logger } from "./logger.js";

export interface Contact {
  name: string;
  email?: string;
  phone?: string;
  source: "platform" | "crm_ch" | "crm_es" | "crm_fr" | "crm_it";
  company?: string;
  title?: string;
  userId?: string;
  teamId?: string;
}

/**
 * Look up external contacts by name or email across:
 * 1. Platform users + emails tables (BigQuery public dataset)
 * 2. Close CRM contacts (all 4 markets)
 */
export async function lookupContact(query: string): Promise<Contact[]> {
  // Dynamic import to avoid loading BQ on every request
  const { BigQuery } = await import("@google-cloud/bigquery");

  const bq = new BigQuery({
    projectId: process.env.GCP_PROJECT_ID || "realadvisor-184710",
  });

  const searchTerm = query.trim().toLowerCase();
  const results: Contact[] = [];

  // 1. Search platform users
  try {
    const [platformRows] = await bq.query({
      query: `
        SELECT
          u.id as user_id,
          u.first_name,
          u.last_name,
          u.full_name,
          u.display_name,
          u.team_id,
          e.email,
          t.name as team_name
        FROM \`public.users\` u
        LEFT JOIN \`public.emails\` e ON e.user_id = u.id AND e.\`primary\` = true
        LEFT JOIN \`public.teams\` t ON t.id = u.team_id
        WHERE u.is_deleted = false
          AND (
            LOWER(u.full_name) LIKE @search
            OR LOWER(u.first_name) LIKE @search
            OR LOWER(u.last_name) LIKE @search
            OR LOWER(u.display_name) LIKE @search
            OR LOWER(e.email) LIKE @search
          )
        LIMIT 10
      `,
      params: { search: `%${searchTerm}%` },
    });

    for (const row of platformRows) {
      results.push({
        name:
          row.full_name ||
          row.display_name ||
          `${row.first_name || ""} ${row.last_name || ""}`.trim(),
        email: row.email || undefined,
        source: "platform",
        company: row.team_name || undefined,
        userId: row.user_id,
        teamId: row.team_id || undefined,
      });
    }
  } catch (err: any) {
    logger.error("Platform contact lookup failed", { error: err.message });
  }

  // 2. Search Close CRM contacts across all markets
  const markets = [
    { dataset: "ch_close", source: "crm_ch" as const },
    { dataset: "es_close", source: "crm_es" as const },
    { dataset: "fr_close", source: "crm_fr" as const },
    { dataset: "it_close", source: "crm_it" as const },
  ];

  for (const { dataset, source } of markets) {
    try {
      const [crmRows] = await bq.query({
        query: `
          SELECT
            c.name,
            c.display_name,
            c.title,
            c.emails,
            c.phones,
            l.display_name as lead_name
          FROM \`${dataset}.contacts\` c
          LEFT JOIN \`${dataset}.leads\` l ON l.id = c.lead_id
          WHERE LOWER(c.name) LIKE @search
            OR LOWER(c.display_name) LIKE @search
          LIMIT 5
        `,
        params: { search: `%${searchTerm}%` },
      });

      for (const row of crmRows) {
        // Parse emails JSON
        let email: string | undefined;
        let phone: string | undefined;
        try {
          const emails = typeof row.emails === "string" ? JSON.parse(row.emails) : row.emails;
          if (Array.isArray(emails) && emails.length > 0) {
            email = emails[0].email;
          }
        } catch {}
        try {
          const phones = typeof row.phones === "string" ? JSON.parse(row.phones) : row.phones;
          if (Array.isArray(phones) && phones.length > 0) {
            phone = phones[0].phone;
          }
        } catch {}

        results.push({
          name: row.display_name || row.name || "Unknown",
          email,
          phone,
          source,
          company: row.lead_name || undefined,
          title: row.title || undefined,
        });
      }
    } catch (err: any) {
      logger.error(`CRM contact lookup failed for ${dataset}`, {
        error: err.message,
      });
    }
  }

  logger.info("Contact lookup completed", {
    query: searchTerm,
    resultCount: results.length,
  });

  return results;
}

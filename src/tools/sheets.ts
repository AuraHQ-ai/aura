import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { logger } from "../lib/logger.js";

const SHEETS_URL_REGEX =
  /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;

const MAX_RESULT_CHARS = 8000;

function extractSpreadsheetId(input: string): string {
  const match = input.match(SHEETS_URL_REGEX);
  if (match) return match[1];
  return input.trim();
}

function extractGidFromUrl(input: string): number | null {
  const match = input.match(/[#&]gid=(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

async function getAccessToken(): Promise<string | null> {
  const { getOAuth2Client, getRefreshToken } = await import(
    "../lib/gmail.js"
  );
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return null;

  const client = await getOAuth2Client();
  if (!client) return null;

  const { token } = await client.getAccessToken();
  return token ?? null;
}

interface SheetMetadata {
  properties: { title: string; sheetId: number };
}

interface SpreadsheetMetadata {
  spreadsheetId: string;
  properties: { title: string };
  sheets: SheetMetadata[];
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const status = res.status;
    if (status === 404) {
      throw new Error(
        "Spreadsheet not found. Check the ID and make sure it exists.",
      );
    }
    if (status === 403) {
      throw new Error(
        "No access to this spreadsheet. Make sure it's shared with Aura's Google account (aura@realadvisor.com).",
      );
    }
    throw new Error(`Google Sheets API error ${status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export function createSheetsTools() {
  return {
    read_google_sheet: defineTool({
      description:
        "Read data from a Google Sheets spreadsheet. Accepts a spreadsheet ID or a full Google Sheets URL. The spreadsheet must be shared with aura@realadvisor.com (or be publicly accessible). Returns headers and rows.",
      inputSchema: z.object({
        spreadsheet_id: z
          .string()
          .describe(
            "The spreadsheet ID or full Google Sheets URL, e.g. '1FDxxuynX5FX214dN-aT8WFbO7EclXt5tWUs-l8Vd7b0' or 'https://docs.google.com/spreadsheets/d/1FDx.../edit'",
          ),
        range: z
          .string()
          .optional()
          .describe(
            "A1 notation range, e.g. 'Sheet1!A1:D10'. If omitted, reads all data from the first sheet (or the sheet matching the URL's gid).",
          ),
        max_rows: z
          .number()
          .min(1)
          .max(1000)
          .default(100)
          .describe("Maximum data rows to return (default 100, max 1000)"),
      }),
      execute: async ({ spreadsheet_id, range, max_rows }) => {
        try {
          const token = await getAccessToken();
          if (!token) {
            return {
              ok: false,
              error:
                "Google OAuth is not configured. Set GOOGLE_EMAIL_CLIENT_ID, GOOGLE_EMAIL_CLIENT_SECRET, and a refresh token with spreadsheets.readonly scope.",
            };
          }

          const id = extractSpreadsheetId(spreadsheet_id);
          const gid = extractGidFromUrl(spreadsheet_id);

          let effectiveRange = range;

          if (!effectiveRange) {
            const meta = await fetchJson<SpreadsheetMetadata>(
              `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=spreadsheetId,properties.title,sheets.properties`,
              token,
            );

            let sheetName: string;
            if (gid != null) {
              const match = meta.sheets.find(
                (s) => s.properties.sheetId === gid,
              );
              sheetName = match
                ? match.properties.title
                : meta.sheets[0]?.properties.title ?? "Sheet1";
            } else {
              sheetName = meta.sheets[0]?.properties.title ?? "Sheet1";
            }
            effectiveRange =
              "'" + sheetName.replace(/'/g, "''") + "'";
          }

          const data = await fetchJson<{
            range: string;
            majorDimension: string;
            values?: string[][];
          }>(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(effectiveRange)}`,
            token,
          );

          const allRows = data.values ?? [];
          const headers = allRows[0] ?? [];
          const totalDataRows = Math.max(0, allRows.length - 1);
          const rows = allRows.slice(1, 1 + max_rows);

          logger.info("read_google_sheet tool called", {
            spreadsheet_id: id,
            range: effectiveRange,
            rowCount: rows.length,
            totalDataRows,
          });

          let result: Record<string, unknown> = {
            ok: true,
            spreadsheet_id: id,
            range: effectiveRange,
            headers,
            rows,
            total_rows: totalDataRows,
          };

          const serialized = JSON.stringify(result);
          if (serialized.length > MAX_RESULT_CHARS) {
            let truncated = rows.slice();
            do {
              truncated = truncated.slice(0, Math.floor(truncated.length / 2));
              result = {
                ok: true,
                spreadsheet_id: id,
                range: effectiveRange,
                headers,
                rows: truncated,
                total_rows: totalDataRows,
                _truncated: true,
                _note: `Showing ${truncated.length} of ${totalDataRows} rows to stay within size limits. Use a specific range to narrow results.`,
              };
            } while (
              JSON.stringify(result).length > MAX_RESULT_CHARS &&
              truncated.length > 0
            );
          }

          return result;
        } catch (error: any) {
          logger.error("read_google_sheet tool failed", {
            spreadsheet_id,
            range,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to read Google Sheet: ${error.message}`,
          };
        }
      },
      slack: {
        status: "Reading spreadsheet...",
        detail: (i) => i.spreadsheet_id?.slice(0, 40),
        output: (r) => {
          if (r.ok === false && typeof r.error === "string") return r.error;
          return `${Number(r.total_rows) || 0} rows`;
        },
      },
    }),
  };
}

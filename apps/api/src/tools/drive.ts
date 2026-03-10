import { z } from "zod";
import { defineTool, binaryToModelOutput } from "../lib/tool.js";
import { logger } from "../lib/logger.js";
import { isTextMimeType } from "../lib/files.js";
import { resolveEffectiveUserId } from "../lib/resolve-user.js";
import type { ScheduleContext } from "@aura/db/schema";

const MAX_DOWNLOAD_SIZE = 10 * 1024 * 1024; // 10 MB

const FILE_FIELDS =
  "files(id,name,mimeType,modifiedTime,owners,size,parents)";

async function getDriveClient(userId?: string) {
  const { getOAuth2Client } = await import("../lib/gmail.js");
  const client = await getOAuth2Client(userId);
  if (!client) return null;

  const { drive } = await import("@googleapis/drive");
  return drive({ version: "v3", auth: client });
}

function getDriveNoAccessError(
  userName: string | undefined,
  context?: ScheduleContext,
): string {
  if (userName) {
    return `No Google Drive access for '${userName}'. They may need to authorize Aura via OAuth first.`;
  }
  if (context?.userId) {
    return "You need to connect your Google account first. Ask me to generate an auth link.";
  }
  return "Google Drive is not configured. Ensure OAuth credentials and a refresh token with drive.readonly scope are set up.";
}

export function createDriveTools(context?: ScheduleContext) {
  return {
    search_drive: defineTool({
      description:
        "Search Google Drive for files and documents. Defaults to the caller's account. Set user_name to access another user's Drive (requires their OAuth access). Uses the Drive search query syntax (e.g. \"name contains 'budget'\", \"mimeType='application/vnd.google-apps.spreadsheet'\", \"fullText contains 'quarterly review'\"). Returns file names, IDs, types, modification dates, owners, and sizes. Use this to find documents before reading them with read_drive_file.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Search query using Google Drive search syntax, e.g. \"name contains 'report'\" or \"fullText contains 'Q4 results'\"",
          ),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe("Maximum number of results to return (default 10, max 50)"),
        user_name: z
          .string()
          .optional()
          .describe(
            "Access another user's Drive instead of the caller's. The display name, real name, or username, e.g. 'Joan' or '@joan'.",
          ),
      }),
      execute: async ({ query, limit, user_name }) => {
        try {
          const { userId: resolvedUserId, error: resolveError } =
            await resolveEffectiveUserId(user_name, context);
          if (resolveError) {
            return { ok: false, error: resolveError };
          }

          const drive = await getDriveClient(resolvedUserId);
          if (!drive) {
            return {
              ok: false,
              error: getDriveNoAccessError(user_name, context),
            };
          }

          const res = await drive.files.list({
            q: `(${query}) and trashed = false`,
            pageSize: limit,
            fields: FILE_FIELDS,
            orderBy: "modifiedTime desc",
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });

          const files = (res.data.files || []).map((f: any) => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            modifiedTime: f.modifiedTime,
            owner: f.owners?.[0]?.displayName || f.owners?.[0]?.emailAddress,
            size: f.size ? parseInt(f.size, 10) : undefined,
          }));

          logger.info("search_drive tool called", {
            query,
            resultCount: files.length,
          });

          return { ok: true as const, files, total: files.length };
        } catch (error: any) {
          logger.error("search_drive tool failed", { query, error: error.message });
          return {
            ok: false,
            error: `Failed to search Drive: ${error.message}`,
          };
        }
      },
      slack: {
        status: "Searching Google Drive...",
        detail: (i) => i.query?.slice(0, 60),
        output: (r) =>
          r.ok === false ? r.error : `${r.files?.length ?? 0} files found`,
      },
    }),

    read_drive_file: defineTool({
      description:
        "Read the content of a file from Google Drive by its file ID. Defaults to the caller's account. Set user_name to access another user's Drive (requires their OAuth access). For Google Docs and Slides, exports as plain text. For Google Sheets, tells you to use the read_google_sheet tool instead. For PDFs and images, returns base64-encoded content. For other file types, returns text content or base64 depending on the mime type. Maximum file size: 10 MB.",
      inputSchema: z.object({
        file_id: z
          .string()
          .describe("The Google Drive file ID to read"),
        user_name: z
          .string()
          .optional()
          .describe(
            "Access another user's Drive instead of the caller's. The display name, real name, or username, e.g. 'Joan' or '@joan'.",
          ),
      }),
      execute: async ({ file_id, user_name }) => {
        try {
          const { userId: resolvedUserId, error: resolveError } =
            await resolveEffectiveUserId(user_name, context);
          if (resolveError) {
            return { ok: false, error: resolveError };
          }

          const drive = await getDriveClient(resolvedUserId);
          if (!drive) {
            return {
              ok: false,
              error: getDriveNoAccessError(user_name, context),
            };
          }

          const meta = await drive.files.get({
            fileId: file_id,
            fields: "id,name,mimeType,size,modifiedTime,owners",
            supportsAllDrives: true,
          });

          const file = meta.data;
          const mimeType = file.mimeType || "application/octet-stream";
          const name = file.name || "unknown";
          const size = file.size ? parseInt(file.size, 10) : undefined;

          const fileInfo = {
            id: file.id,
            name,
            mimeType,
            size,
            modifiedTime: file.modifiedTime,
            owner: file.owners?.[0]?.displayName || file.owners?.[0]?.emailAddress,
          };

          if (mimeType === "application/vnd.google-apps.spreadsheet") {
            return {
              ok: true,
              ...fileInfo,
              content: null,
              note: "This is a Google Sheets spreadsheet. Use the read_google_sheet tool with this file ID to read its contents.",
            };
          }

          if (
            mimeType === "application/vnd.google-apps.document" ||
            mimeType === "application/vnd.google-apps.presentation"
          ) {
            const exported = await drive.files.export({
              fileId: file_id,
              mimeType: "text/plain",
            });
            const content =
              typeof exported.data === "string"
                ? exported.data
                : String(exported.data);

            const label =
              mimeType === "application/vnd.google-apps.document"
                ? "Google Doc"
                : "Google Slides";
            logger.info(`read_drive_file: exported ${label}`, {
              file_id,
              name,
              contentLength: content.length,
            });

            return { ok: true, ...fileInfo, content, encoding: "text" };
          }

          // For other Google Workspace types (drawings, forms, etc.), skip download
          if (mimeType.startsWith("application/vnd.google-apps.")) {
            return {
              ok: true,
              ...fileInfo,
              content: null,
              note: `This is a Google Workspace file (${mimeType}) that cannot be exported as text. Open it in Google Drive directly.`,
            };
          }

          if (size && size > MAX_DOWNLOAD_SIZE) {
            return {
              ok: false,
              error: `File is too large to download (${(size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`,
              ...fileInfo,
            };
          }

          const downloaded = await drive.files.get(
            { fileId: file_id, alt: "media", supportsAllDrives: true },
            { responseType: "arraybuffer" },
          );

          const buffer = Buffer.from(downloaded.data as ArrayBuffer);

          if (
            mimeType === "application/pdf" ||
            mimeType.startsWith("image/")
          ) {
            logger.info("read_drive_file: downloaded binary file", {
              file_id,
              name,
              mimeType,
              size: buffer.length,
            });

            return {
              ok: true,
              ...fileInfo,
              content: buffer.toString("base64"),
              encoding: "base64",
            };
          }

          if (isTextMimeType(mimeType)) {
            const content = buffer.toString("utf-8");
            logger.info("read_drive_file: downloaded text file", {
              file_id,
              name,
              mimeType,
              contentLength: content.length,
            });

            return { ok: true, ...fileInfo, content, encoding: "text" };
          }

          logger.info("read_drive_file: downloaded binary file (non-image/pdf)", {
            file_id,
            name,
            mimeType,
            size: buffer.length,
          });

          return {
            ok: true,
            ...fileInfo,
            content: buffer.toString("base64"),
            encoding: "base64",
          };
        } catch (error: any) {
          logger.error("read_drive_file tool failed", {
            file_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to read Drive file: ${error.message}`,
          };
        }
      },
      toModelOutput({ output }: { output: any }) {
        if (!output?.ok || output.encoding !== "base64" || !output.content) {
          return { type: "json" as const, value: output };
        }
        const { content, ...meta } = output;
        return binaryToModelOutput({ base64: content, mimeType: output.mimeType, filename: output.name, meta });
      },
      slack: {
        status: "Reading file from Drive...",
        detail: (i) => i.file_id?.slice(0, 30),
        output: (r: any) => {
          if (r.ok === false) return r.error;
          if (r.note) return r.note;
          return r.name || "File read";
        },
      },
    }),

    list_drive_folder: defineTool({
      description:
        "List files in a Google Drive folder. Defaults to the caller's account. Set user_name to access another user's Drive (requires their OAuth access). If no folder_id is provided, lists files in the root of My Drive. To browse a shared drive, pass its drive_id (from list_shared_drives). Returns file names, IDs, types, modification dates, and sizes.",
      inputSchema: z.object({
        folder_id: z
          .string()
          .default("root")
          .describe(
            "The folder ID to list contents of. Defaults to 'root' (My Drive root).",
          ),
        drive_id: z
          .string()
          .optional()
          .describe(
            "Shared drive ID. When provided, lists files in this shared drive instead of My Drive. Get drive IDs from list_shared_drives.",
          ),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(20)
          .describe(
            "Maximum number of files to return (default 20, max 100)",
          ),
        user_name: z
          .string()
          .optional()
          .describe(
            "Access another user's Drive instead of the caller's. The display name, real name, or username, e.g. 'Joan' or '@joan'.",
          ),
      }),
      execute: async ({ folder_id, drive_id, limit, user_name }) => {
        try {
          const { userId: resolvedUserId, error: resolveError } =
            await resolveEffectiveUserId(user_name, context);
          if (resolveError) {
            return { ok: false, error: resolveError };
          }

          const drive = await getDriveClient(resolvedUserId);
          if (!drive) {
            return {
              ok: false,
              error: getDriveNoAccessError(user_name, context),
            };
          }

          const effectiveFolder =
            drive_id && folder_id === "root" ? drive_id : folder_id;

          if (effectiveFolder !== "root" && !/^[\w-]+$/.test(effectiveFolder)) {
            return { ok: false, error: "Invalid folder ID format." };
          }

          const listParams: Record<string, any> = {
            q: `'${effectiveFolder}' in parents and trashed = false`,
            pageSize: limit,
            fields: FILE_FIELDS,
            orderBy: "folder,name",
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          };

          if (drive_id) {
            listParams.corpora = "drive";
            listParams.driveId = drive_id;
          }

          const res = await drive.files.list(listParams);

          const files = (res.data.files || []).map((f: any) => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            modifiedTime: f.modifiedTime,
            size: f.size ? parseInt(f.size, 10) : undefined,
          }));

          logger.info("list_drive_folder tool called", {
            folder_id: effectiveFolder,
            drive_id,
            resultCount: files.length,
          });

          return {
            ok: true as const,
            folder_id: effectiveFolder,
            drive_id,
            files,
            total: files.length,
          };
        } catch (error: any) {
          logger.error("list_drive_folder tool failed", {
            folder_id,
            drive_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to list Drive folder: ${error.message}`,
          };
        }
      },
      slack: {
        status: "Browsing Drive folder...",
        detail: (i) =>
          i.drive_id
            ? `Shared drive ${i.drive_id.slice(0, 15)}`
            : i.folder_id === "root"
              ? "My Drive"
              : i.folder_id?.slice(0, 30),
        output: (r) =>
          r.ok === false ? r.error : `${r.files?.length ?? 0} items`,
      },
    }),

    list_shared_drives: defineTool({
      description:
        "List all shared drives in the Google Workspace organization. Defaults to the caller's account. Set user_name to access via another user's OAuth token (requires their OAuth access). Returns drive names and IDs. Use the drive ID with list_drive_folder to browse contents of a shared drive.",
      inputSchema: z.object({
        user_name: z
          .string()
          .optional()
          .describe(
            "Access via another user's Drive instead of the caller's. The display name, real name, or username, e.g. 'Joan' or '@joan'.",
          ),
      }),
      execute: async ({ user_name }) => {
        try {
          const { userId: resolvedUserId, error: resolveError } =
            await resolveEffectiveUserId(user_name, context);
          if (resolveError) {
            return { ok: false, error: resolveError };
          }

          const drive = await getDriveClient(resolvedUserId);
          if (!drive) {
            return {
              ok: false,
              error: getDriveNoAccessError(user_name, context),
            };
          }

          const res = await drive.drives.list({
            pageSize: 100,
            fields: "drives(id,name)",
          });

          const drives = (res.data.drives || []).map((d: any) => ({
            id: d.id,
            name: d.name,
          }));

          logger.info("list_shared_drives tool called", {
            resultCount: drives.length,
          });

          return { ok: true as const, drives, total: drives.length };
        } catch (error: any) {
          logger.error("list_shared_drives tool failed", {
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to list shared drives: ${error.message}`,
          };
        }
      },
      slack: {
        status: "Listing shared drives...",
        output: (r) =>
          r.ok === false ? r.error : `${r.drives?.length ?? 0} shared drives`,
      },
    }),
  };
}

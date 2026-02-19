import { logger } from "./logger.js";

/** Max file size to download (20MB) */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/**
 * MIME types that model providers widely accept as FilePart input.
 * Everything else that isn't an image or text gets a text-description fallback
 * so one unsupported attachment can't crash the whole LLM call.
 */
const SUPPORTED_FILE_PART_TYPES = new Set([
  "application/pdf",
]);

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/csv",
  "application/x-yaml",
  "application/yaml",
  "application/sql",
  "application/graphql",
  "application/x-sh",
  "application/xhtml+xml",
]);

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType);
}

/** AI SDK content part for a user message file attachment. */
export type FileContentPart =
  | { type: "image"; image: Uint8Array; mediaType: string }
  | { type: "file"; data: Uint8Array; mediaType: string; filename: string }
  | { type: "text"; text: string };

/**
 * Extract downloadable files from a Slack event.
 * Accepts all file types, filtering only by size and presence of a download URL.
 */
export function getEventFiles(
  event: any,
): { url: string; mimetype: string; name: string; size: number }[] {
  const files = event.files;
  if (!Array.isArray(files) || files.length === 0) return [];

  return files
    .filter((f: any) => {
      const url = f.url_private_download || f.url_private;
      if (!url) return false;
      if (f.size && f.size > MAX_FILE_SIZE) {
        logger.warn("Skipping large file (exceeds 20MB limit)", {
          name: f.name,
          size: f.size,
          mimetype: f.mimetype,
        });
        return false;
      }
      return true;
    })
    .map((f: any) => ({
      url: f.url_private_download || f.url_private,
      mimetype: f.mimetype || "application/octet-stream",
      name: f.name || "file",
      size: f.size || 0,
    }));
}

/**
 * Download a file from Slack's private URL using the bot token.
 */
async function downloadSlackFile(
  url: string,
  botToken: string,
): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to download file: HTTP ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

/** Convert raw file data + metadata into an AI SDK content part. */
function toContentPart(
  data: Uint8Array,
  mimeType: string,
  name: string,
): FileContentPart {
  if (IMAGE_MIME_TYPES.has(mimeType)) {
    return { type: "image", image: data, mediaType: mimeType };
  }

  if (isTextMimeType(mimeType)) {
    const text = new TextDecoder().decode(data);
    return { type: "text", text: `[File: ${name}]\n${text}` };
  }

  if (SUPPORTED_FILE_PART_TYPES.has(mimeType)) {
    return { type: "file", data, mediaType: mimeType, filename: name };
  }

  // Binary types without broad model support (audio, video, docx, etc.):
  // include a text description so the model knows a file was attached
  // without risking an unsupported-media-type error that kills the response.
  const sizeKB = Math.round(data.length / 1024);
  return {
    type: "text",
    text: `[Attached file: ${name} (${mimeType}, ${sizeKB} KB) — this binary file type cannot be processed directly]`,
  };
}

/**
 * Download all files from a Slack event and convert to AI SDK content parts.
 */
export async function downloadEventFiles(
  event: any,
  botToken: string,
): Promise<FileContentPart[]> {
  const files = getEventFiles(event);
  if (files.length === 0) return [];

  const parts: FileContentPart[] = [];

  for (const file of files) {
    try {
      const data = await downloadSlackFile(file.url, botToken);
      const part = toContentPart(data, file.mimetype, file.name);
      parts.push(part);
      logger.info("Downloaded Slack file", {
        name: file.name,
        size: data.length,
        mimeType: file.mimetype,
        partType: part.type,
      });
    } catch (error: any) {
      logger.error("Failed to download Slack file", {
        name: file.name,
        url: file.url,
        error: error.message,
      });
    }
  }

  return parts;
}

import { logger } from "./logger.js";

/** Supported image MIME types for multimodal LLM input */
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Max file size to download (10MB) */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export interface SlackImage {
  data: Uint8Array;
  mimeType: string;
  name: string;
}

/**
 * Extract downloadable image files from a Slack event.
 * Filters for supported image types and reasonable sizes.
 */
export function getImageFiles(
  event: any,
): { url_private_download: string; mimetype: string; name: string; size: number }[] {
  const files = event.files;
  if (!Array.isArray(files) || files.length === 0) return [];

  return files.filter((f: any) => {
    // Slack uses url_private_download or url_private
    if (!f.url_private_download && !f.url_private) return false;
    if (!f.url_private_download) f.url_private_download = f.url_private;
    if (!f.mimetype || !SUPPORTED_IMAGE_TYPES.has(f.mimetype)) return false;
    if (f.size && f.size > MAX_FILE_SIZE) {
      logger.warn("Skipping large image file", {
        name: f.name,
        size: f.size,
      });
      return false;
    }
    return true;
  });
}

/**
 * Download an image from Slack's private URL using the bot token.
 * Returns raw bytes as Uint8Array (no base64 needed for AI SDK v6).
 */
export async function downloadSlackImage(
  url: string,
  botToken: string,
): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Failed to download image: HTTP ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Download all image files from a Slack event.
 * Returns an array of SlackImage objects ready for multimodal input.
 */
export async function downloadEventImages(
  event: any,
  botToken: string,
): Promise<SlackImage[]> {
  const imageFiles = getImageFiles(event);
  if (imageFiles.length === 0) return [];

  const images: SlackImage[] = [];

  for (const file of imageFiles) {
    try {
      const data = await downloadSlackImage(
        file.url_private_download,
        botToken,
      );
      images.push({
        data,
        mimeType: file.mimetype,
        name: file.name || "image",
      });
      logger.info("Downloaded Slack image", {
        name: file.name,
        size: data.length,
        mimeType: file.mimetype,
      });
    } catch (error: any) {
      logger.error("Failed to download Slack image", {
        name: file.name,
        url: file.url_private_download,
        error: error.message,
      });
    }
  }

  return images;
}

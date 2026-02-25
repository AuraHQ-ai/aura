import type { WebClient } from "@slack/web-api";
import { logger } from "./logger.js";

/**
 * Upload a file buffer to Slack using the 3-step external upload API.
 *
 * Steps: getUploadURLExternal → PUT file content → completeUploadExternal
 */
export async function uploadFileToSlack(
  client: WebClient,
  options: {
    buffer: Buffer;
    filename: string;
    title?: string;
    channelId?: string;
    threadTs?: string;
  },
): Promise<{ fileId: string; fileUrl: string | null }> {
  const { buffer, filename, title, channelId, threadTs } = options;

  const uploadUrlResp = await client.files.getUploadURLExternal({
    filename,
    length: buffer.length,
  });
  const uploadUrl = uploadUrlResp.upload_url!;
  const fileId = uploadUrlResp.file_id!;

  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    body: buffer,
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (!uploadResp.ok) {
    throw new Error(
      `File upload failed: ${uploadResp.status} ${uploadResp.statusText}`,
    );
  }

  const completeParams: Record<string, unknown> = {
    files: [{ id: fileId, title: title || filename }],
  };
  if (channelId) completeParams.channel_id = channelId;
  if (threadTs) completeParams.thread_ts = threadTs;

  const completeResp = await client.files.completeUploadExternal(
    completeParams as any,
  );

  const fileUrl =
    (completeResp as any).files?.[0]?.permalink ?? null;

  logger.info("uploadFileToSlack completed", { filename, fileId, channelId });

  return { fileId, fileUrl };
}

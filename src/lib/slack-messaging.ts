import type { WebClient } from "@slack/web-api";
import { logger } from "./logger.js";

/**
 * Detect Slack's `channel_type_not_supported` error, which is thrown when
 * an API method (e.g. `chat.startStream`, `chat.postMessage`) is called on
 * a channel type that doesn't support it (e.g. Slack List internal channels).
 */
export function isChannelTypeNotSupported(error: any): boolean {
  const msg = error?.message || "";
  const code = error?.data?.error || "";
  return (
    msg.includes("channel_type_not_supported") ||
    code === "channel_type_not_supported"
  );
}

export function isInvalidBlocks(error: any): boolean {
  const msg = error?.message || "";
  const code = error?.data?.error || "";
  return msg.includes("invalid_blocks") || code === "invalid_blocks";
}

export function isMsgTooLong(error: any): boolean {
  const msg = error?.message || "";
  const code = error?.data?.error || "";
  return msg.includes("msg_too_long") || code === "msg_too_long";
}

const MSG_TRUNCATE_LIMIT = 39_000;

/**
 * Post a message to Slack with automatic fallback for rejected blocks
 * and unsupported channel types. This is the ONLY way to call chat.postMessage
 * in the codebase.
 *
 * Retry logic:
 * 1. Try posting with blocks (if provided)
 * 2. If `invalid_blocks` or `channel_type_not_supported`: retry WITHOUT blocks (plain text only)
 * 3. If the plain-text retry also gets `channel_type_not_supported`: log warning, don't crash
 * 4. If `msg_too_long` on retry: truncate text and retry once more
 * 5. All other errors: re-throw
 */
export async function safePostMessage(
  client: WebClient,
  options: {
    channel: string;
    text: string;
    thread_ts?: string;
    blocks?: any[];
    metadata?: any;
    unfurl_links?: boolean;
    unfurl_media?: boolean;
  },
): Promise<{ ok: boolean; ts?: string; channel?: string }> {
  const { channel, text, thread_ts, blocks, metadata, unfurl_links, unfurl_media } = options;

  try {
    const result = await client.chat.postMessage({
      channel,
      text,
      thread_ts,
      blocks,
      metadata,
      unfurl_links,
      unfurl_media,
    });
    return { ok: true, ts: result.ts, channel: result.channel };
  } catch (err: any) {
    const hasBlocks = blocks && blocks.length > 0;

    if ((isInvalidBlocks(err) || isChannelTypeNotSupported(err)) && hasBlocks) {
      logger.warn("safePostMessage: retrying without blocks", {
        channel,
        originalError: err?.data?.error || err?.message,
        fallbackReason: isInvalidBlocks(err) ? "invalid_blocks" : "channel_type_not_supported",
      });

      try {
        const result = await client.chat.postMessage({
          channel,
          text,
          thread_ts,
          metadata,
          unfurl_links,
          unfurl_media,
        });
        return { ok: true, ts: result.ts, channel: result.channel };
      } catch (retryErr: any) {
        if (isChannelTypeNotSupported(retryErr)) {
          logger.warn("safePostMessage: channel type not supported even without blocks, giving up", {
            channel,
            originalError: err?.data?.error || err?.message,
          });
          return { ok: false };
        }

        if (isMsgTooLong(retryErr)) {
          logger.warn("safePostMessage: msg_too_long on retry, truncating", {
            channel,
            textLength: text.length,
          });
          try {
            const result = await client.chat.postMessage({
              channel,
              text: text.slice(0, MSG_TRUNCATE_LIMIT),
              thread_ts,
              metadata,
              unfurl_links,
              unfurl_media,
            });
            return { ok: true, ts: result.ts, channel: result.channel };
          } catch (truncateErr: any) {
            if (isChannelTypeNotSupported(truncateErr)) {
              logger.warn("safePostMessage: channel type not supported after truncation", { channel });
              return { ok: false };
            }
            throw truncateErr;
          }
        }

        throw retryErr;
      }
    }

    if (isChannelTypeNotSupported(err) && !hasBlocks) {
      logger.warn("safePostMessage: channel type not supported (no blocks to strip)", {
        channel,
        originalError: err?.data?.error || err?.message,
      });
      return { ok: false };
    }

    if (isMsgTooLong(err)) {
      logger.warn("safePostMessage: msg_too_long, truncating and retrying", {
        channel,
        textLength: text.length,
      });
      try {
        const result = await client.chat.postMessage({
          channel,
          text: text.slice(0, MSG_TRUNCATE_LIMIT),
          thread_ts,
          blocks,
          metadata,
          unfurl_links,
          unfurl_media,
        });
        return { ok: true, ts: result.ts, channel: result.channel };
      } catch (retryErr: any) {
        if (isChannelTypeNotSupported(retryErr) || isInvalidBlocks(retryErr)) {
          try {
            const result = await client.chat.postMessage({
              channel,
              text: text.slice(0, MSG_TRUNCATE_LIMIT),
              thread_ts,
              metadata,
              unfurl_links,
              unfurl_media,
            });
            return { ok: true, ts: result.ts, channel: result.channel };
          } catch (finalErr: any) {
            if (isChannelTypeNotSupported(finalErr)) {
              logger.warn("safePostMessage: channel type not supported after truncation", { channel });
              return { ok: false };
            }
            throw finalErr;
          }
        }
        throw retryErr;
      }
    }

    throw err;
  }
}

import { tool, type Tool } from "ai";
import type { ZodType } from "zod";

// ── Slack Card Metadata ──────────────────────────────────────────────────────
// Co-located with tool definitions via defineTool() so that Slack card behavior
// (spinner label, input summary, output summary, URL citations) stays in sync
// with the tool itself instead of drifting in separate switch blocks.

export interface SlackToolMetadata<TInput = any, TOutput = any> {
  /** Spinner label shown while tool is running, e.g. "Searching the web..." */
  status: string;
  /** Extract a short detail from input args for the in-progress card */
  detail?: (input: TInput) => string | undefined;
  /** Extract a short summary from result for the completed card */
  output?: (result: TOutput) => string | undefined;
  /** Extract URL citations for web tool cards */
  sources?: (
    result: TOutput,
  ) => Array<{ type: "url"; url: string; text: string }> | undefined;
}

/**
 * Retrieve the Slack card metadata from a tool, if it was created with
 * defineTool(). Returns undefined for tools created with the standard
 * AI SDK tool() helper.
 */
export function getSlackMeta(t: unknown): SlackToolMetadata | undefined {
  if (t && typeof t === "object" && "slack" in t) {
    return (t as { slack: SlackToolMetadata }).slack;
  }
  return undefined;
}

/**
 * Wrapper around AI SDK's tool() that co-locates Slack card metadata with the
 * tool definition. The optional `slack` field is attached directly to the
 * returned tool object so respond.ts can read it at runtime without maintaining
 * separate switch blocks.
 *
 * Usage:
 * ```ts
 * const myTool = defineTool({
 *   description: "...",
 *   inputSchema: z.object({ query: z.string() }),
 *   execute: async ({ query }) => ({ ok: true, results: [] }),
 *   slack: {
 *     status: "Searching...",
 *     detail: (input) => input.query,
 *     output: (result) => `${result.results.length} results`,
 *   },
 * });
 * ```
 */
export function defineTool<TInput, TOutput>(config: {
  description: string;
  inputSchema: ZodType<TInput, any, any>;
  execute: (input: TInput) => PromiseLike<TOutput>;
  slack?: SlackToolMetadata<TInput, TOutput>;
  toModelOutput?: Tool<TInput, TOutput>["toModelOutput"];
}) {
  const { slack, ...toolConfig } = config;
  // The spread loses the generic relationship between TInput/TOutput and the
  // Tool intersection type, so we go through `unknown` to satisfy the compiler.
  const t = tool<TInput, TOutput>(
    toolConfig as unknown as Tool<TInput, TOutput>,
  );
  if (slack) {
    (t as any).slack = slack;
  }
  return t as Tool<TInput, TOutput> & {
    slack?: SlackToolMetadata<TInput, TOutput>;
  };
}

/**
 * Build a toModelOutput result for tools that return binary content (images, PDFs, etc).
 * Converts base64 strings into native AI SDK content parts so the LLM can see the file.
 */
export function binaryToModelOutput(opts: {
  base64: string;
  mimeType: string;
  filename?: string;
  meta?: Record<string, unknown>;
}): {
  type: "content";
  value: Array<
    | { type: "text"; text: string }
    | { type: "image-data"; data: string; mediaType: string }
    | { type: "file-data"; data: string; mediaType: string; filename?: string }
  >;
} {
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "image-data"; data: string; mediaType: string }
    | { type: "file-data"; data: string; mediaType: string; filename?: string }
  > = [];

  if (opts.meta && Object.keys(opts.meta).length > 0) {
    parts.push({
      type: "text",
      text: JSON.stringify({
        ...opts.meta,
        note: "Binary content attached as native file below",
      }),
    });
  }

  if (opts.mimeType?.startsWith("image/")) {
    parts.push({
      type: "image-data",
      data: opts.base64,
      mediaType: opts.mimeType,
    });
  } else {
    parts.push({
      type: "file-data",
      data: opts.base64,
      mediaType: opts.mimeType || "application/octet-stream",
      filename: opts.filename,
    });
  }

  return { type: "content", value: parts };
}

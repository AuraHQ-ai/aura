/**
 * Langfuse tracing bootstrap.
 *
 * Wires the Vercel AI SDK's built-in OpenTelemetry spans into Langfuse via the
 * `LangfuseSpanProcessor`. The AI SDK emits GenAI spans whenever a call passes
 * `experimental_telemetry: { isEnabled: true }`; the processor's default smart
 * filter only exports Langfuse/GenAI/LLM spans, so unrelated HTTP/DB spans never
 * reach Langfuse (and never count toward billable units).
 *
 * Aura runs on Vercel serverless (Fluid Compute). Two consequences:
 *   1. We use `exportMode: "immediate"` so spans are shipped as they end rather
 *      than buffered — a frozen/terminated function instance can't drain a batch.
 *   2. Callers must `flushLangfuse()` once their work completes (inside the
 *      `waitUntil` keep-alive window) to guarantee the final spans are exported
 *      before the instance freezes. See the flush calls in `app.ts`,
 *      `pipeline/index.ts`, and the dashboard chat route.
 *
 * We follow Langfuse's documented Next.js/serverless setup: a manual
 * `NodeTracerProvider` + `LangfuseSpanProcessor` (NOT `@vercel/otel`, which does
 * not yet support the OpenTelemetry JS SDK v2 these packages are built on).
 *
 * The bootstrap auto-initializes on import. Entry points (`src/app.ts` and the
 * cron handlers) import this module first so the provider is registered before
 * any AI SDK call runs. When the Langfuse keys are absent every export here is a
 * no-op, so local/dev environments without keys run unaffected.
 */

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes } from "@langfuse/tracing";
import { logger } from "./logger.js";

let provider: NodeTracerProvider | null = null;
let spanProcessor: LangfuseSpanProcessor | null = null;

/**
 * Redact obvious secrets before any input/output/metadata leaves the process.
 *
 * The processor passes the stringified JSON of each attribute value; we run a
 * few defensive regexes so connection strings, bearer tokens, provider API
 * keys, or card numbers can never be persisted in a trace even if they slip
 * into a prompt or tool result. This is a safety net — prompts in this app do
 * not intentionally include secrets.
 */
function maskSensitiveData({ data }: { data: unknown }): unknown {
  if (typeof data !== "string") return data;

  return (
    data
      // URI-style connection strings with embedded credentials
      // (postgres://user:pass@host, redis://…, mongodb+srv://…, etc.)
      .replace(
        /\b[a-z][a-z0-9+.-]*:\/\/[^\s"':@/]+:[^\s"'@/]+@[^\s"']+/gi,
        "***REDACTED_CONNECTION_STRING***",
      )
      // Authorization: Bearer <token>
      .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, "Bearer ***REDACTED***")
      // Common provider key shapes (sk-/pk-/rk-, Slack xoxb-/xoxp-, SendGrid SG.)
      .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9._-]{12,}/g, "***REDACTED_API_KEY***")
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "***REDACTED_SLACK_TOKEN***")
      .replace(/\bSG\.[A-Za-z0-9._-]{12,}/g, "***REDACTED_API_KEY***")
      // Credit card numbers (PCI safety net)
      .replace(
        /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
        "***REDACTED_CARD***",
      )
  );
}

/**
 * Resolve the tracing environment so preview and production deployments stay
 * separate in Langfuse's Environments view. Vercel sets `VERCEL_ENV` to
 * "production" | "preview" | "development"; fall back to NODE_ENV locally.
 */
function resolveEnvironment(): string {
  return (
    process.env.LANGFUSE_TRACING_ENVIRONMENT ||
    process.env.VERCEL_ENV ||
    process.env.NODE_ENV ||
    "development"
  );
}

/**
 * Initialize Langfuse tracing. Idempotent and safe to call when keys are
 * missing. Returns `true` when tracing was enabled.
 */
export function initLangfuseTracing(): boolean {
  if (provider) return true;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey) {
    logger.warn(
      "Langfuse tracing disabled: LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set",
    );
    return false;
  }

  const environment = resolveEnvironment();

  spanProcessor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    environment,
    // Tie traces to the deployed commit for regression hunting across releases.
    release:
      process.env.LANGFUSE_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA,
    mask: maskSensitiveData,
    // Serverless: ship spans as they end rather than buffering a batch that a
    // frozen/terminated instance could never drain.
    exportMode: "immediate",
  });

  provider = new NodeTracerProvider({
    spanProcessors: [spanProcessor],
  });
  provider.register();

  logger.info("Langfuse tracing initialized", {
    baseUrl: baseUrl || "https://cloud.langfuse.com",
    environment,
  });

  return true;
}

/** Whether Langfuse tracing is active. */
export function isLangfuseEnabled(): boolean {
  return spanProcessor !== null;
}

/**
 * `experimental_telemetry` config for an AI SDK call (`streamText`,
 * `generateText`, `generateObject`, `embed`, the `Agent`/`ToolLoopAgent`
 * constructor, …). Pass a descriptive `functionId` so generations are findable
 * and filterable in Langfuse. Returns `{ isEnabled: false }` when tracing is
 * off, so call sites can spread it unconditionally.
 */
export function aiTelemetry(
  functionId: string,
  metadata?: Record<string, string | number | boolean>,
): { isEnabled: boolean; functionId?: string; metadata?: Record<string, any> } {
  if (!spanProcessor) return { isEnabled: false };
  return { isEnabled: true, functionId, metadata };
}

export interface TraceAttributes {
  /** Human-readable trace name, e.g. "slack-chat" or "memory-extract". */
  traceName?: string;
  /** Groups related turns into one conversation in the Sessions view. */
  sessionId?: string;
  /** Enables per-user cost/quality analysis and filtering. */
  userId?: string;
  /** Filterable labels, e.g. ["channel:slack", "model:..."]. */
  tags?: string[];
  /** Arbitrary trace-level metadata. */
  metadata?: Record<string, any>;
}

/**
 * Group the AI SDK spans created inside `fn` into a single Langfuse trace with
 * session/user/tag attributes. These propagate to every GenAI span created
 * synchronously within the callback (`propagateAttributes` is a synchronous
 * OpenTelemetry context wrapper, so it works for both sync calls that return a
 * stream handle and `async` callbacks). No-op passthrough when tracing is off.
 */
export function withTrace<T>(attrs: TraceAttributes, fn: () => T): T {
  if (!spanProcessor) return fn();
  return propagateAttributes(attrs, fn);
}

/**
 * Flush any buffered spans. Cheap no-op when tracing is disabled. Critical in
 * serverless: call this (inside the `waitUntil` keep-alive window) once a
 * request's AI work completes so the final spans are exported before the
 * function instance freezes.
 */
export async function flushLangfuse(): Promise<void> {
  if (!spanProcessor) return;
  try {
    await spanProcessor.forceFlush();
  } catch (error) {
    logger.warn("Langfuse flush failed", { error });
  }
}

// Auto-initialize on import. Env vars are present at module-load time on Vercel
// and via `node --env-file` locally, so the provider registers before the first
// AI SDK call. Safe no-op when keys are absent.
initLangfuseTracing();

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

import {
  NodeTracerProvider,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes } from "@langfuse/tracing";
import type { Context } from "@opentelemetry/api";
import { logger } from "./logger.js";

let provider: NodeTracerProvider | null = null;
let spanProcessor: LangfuseSpanProcessor | null = null;

const GEN_AI_MODEL_ATTRIBUTES = [
  "gen_ai.request.model",
  "gen_ai.response.model",
  // AI SDK also keeps its pre-GenAI attributes. Langfuse currently prices from
  // GenAI attributes, but normalizing both prevents future drift.
  "ai.model.id",
  "ai.response.model",
];

/**
 * Convert AI Gateway/provider-qualified model IDs into the bare slugs Langfuse's
 * pricing table matches against.
 *
 * Examples:
 * - anthropic/claude-opus-4.8 -> claude-opus-4-8
 * - claude-sonnet-4-6 -> claude-sonnet-4-6
 * - openai/gpt-5.1 -> gpt-5-1
 */
export function normalizeLangfuseModelSlug(
  modelId: string | undefined,
): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed) return undefined;

  const bareSlug = trimmed.split("/").pop() ?? trimmed;
  return bareSlug.replace(/\./g, "-");
}

function normalizeGenAIModelAttributes(span: ReadableSpan): void {
  for (const attributeName of GEN_AI_MODEL_ATTRIBUTES) {
    const value = span.attributes[attributeName];
    if (typeof value !== "string") continue;

    const normalized = normalizeLangfuseModelSlug(value);
    if (normalized) {
      span.attributes[attributeName] = normalized;
    }
  }
}

/**
 * Central pre-export hygiene for Langfuse spans. The delegate keeps Langfuse's
 * smart GenAI span filter, masking, media handling, and serverless flush
 * behavior unchanged; we only canonicalize model slugs before it sees the span.
 */
class LangfuseHygieneSpanProcessor implements SpanProcessor {
  constructor(private readonly delegate: LangfuseSpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    this.delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    normalizeGenAIModelAttributes(span);
    this.delegate.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

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
    spanProcessors: [new LangfuseHygieneSpanProcessor(spanProcessor)],
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

/**
 * Build the `userId` Langfuse should display for a trace.
 *
 * Langfuse's Users view shows the raw `userId` string verbatim, so a bare Slack
 * ID (`U0678NQJ2`) is unreadable when scanning. We format it as
 * `"Display Name (U0678NQJ2)"` — the name is what humans scan for, and the
 * stable Slack ID stays embedded so the same person maps to one Langfuse user
 * (names/handles can change, the ID can't) and remains greppable.
 *
 * Use this everywhere a trace's `userId` is set (Slack, dashboard, …) so a given
 * person is a single user across channels. Falls back to the bare id when no
 * name is available, and returns undefined when there's no id at all.
 */
export function formatTraceUser(
  id: string | undefined,
  name?: string | null,
): string | undefined {
  if (!id) return undefined;
  const trimmed = name?.trim();
  return trimmed ? `${trimmed} (${id})` : id;
}

export interface TraceAttributes {
  /** Human-readable trace name, e.g. "slack-chat" or "memory-extract". */
  traceName?: string;
  /** Groups related turns into one conversation in the Sessions view. */
  sessionId?: string;
  /** Raw stable user id. Formatted centrally before propagation to Langfuse. */
  userId?: string;
  /** Human-readable name rendered with the stable id in Langfuse's Users view. */
  userName?: string | null;
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
  const { userName, ...traceAttrs } = attrs;
  return propagateAttributes(
    {
      ...traceAttrs,
      userId: formatTraceUser(attrs.userId, userName),
    },
    fn,
  );
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

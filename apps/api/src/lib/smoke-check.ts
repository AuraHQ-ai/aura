import { logger } from "./logger.js";

/**
 * Post-deploy smoke check for external API integrations (#986).
 *
 * Each probe performs one real, minimal, *authenticated* call against an
 * integration we depend on (not a ping to a docs page), with a short timeout.
 *
 * Output hygiene (CRITICAL): results carry only the integration name, an
 * ok/failed/skipped status, latency, and a short machine-readable reason code
 * (e.g. "http_401", "timeout", "not_configured"). Raw error messages are
 * never included — they can echo request URLs or headers that contain
 * credentials. The same rule applies to logging in this module.
 */

export type SmokeStatus = "ok" | "failed" | "skipped";

export interface SmokeCheckResult {
  integration: string;
  status: SmokeStatus;
  latencyMs: number;
  /** Short sanitized reason code — never raw error text or credential data. */
  reason?: string;
}

export interface SmokeReport {
  /** True when no probe failed (skipped probes don't count as failures). */
  ok: boolean;
  timestamp: string;
  durationMs: number;
  checks: SmokeCheckResult[];
}

const PROBE_TIMEOUT_MS = 5_000;

/** Probe outcome: "ok", or a skip with a reason code. Failures throw. */
type ProbeOutcome = { status: "ok" } | { status: "skipped"; reason: string };

export type SmokeProbe = (signal: AbortSignal) => Promise<ProbeOutcome>;

const OK: ProbeOutcome = { status: "ok" };

function skipped(reason: string): ProbeOutcome {
  return { status: "skipped", reason };
}

/** Error carrying a pre-sanitized reason code safe to expose in results. */
class ProbeError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "ProbeError";
  }
}

function httpReason(status: number): string {
  return `http_${status}`;
}

/**
 * Map an arbitrary thrown value to a short reason code. Never returns raw
 * error messages — only fixed codes, HTTP status codes, or error class names.
 */
function sanitizeError(error: unknown): string {
  if (error instanceof ProbeError) return error.reason;
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return "timeout";
    }
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return httpReason(status);
    // Class name only (e.g. "AuthenticationError") — never the message.
    return error.name && error.name !== "Error"
      ? `error_${error.name}`
      : "error";
  }
  return "error";
}

// ── Probes ──────────────────────────────────────────────────────────────────

async function probeSlack(_signal: AbortSignal): Promise<ProbeOutcome> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return skipped("not_configured");

  const { WebClient } = await import("@slack/web-api");
  const client = new WebClient(token);
  const res = await client.auth.test();
  if (!res.ok) throw new ProbeError("auth_test_not_ok");
  return OK;
}

async function probeGitHub(signal: AbortSignal): Promise<ProbeOutcome> {
  const { getCredential } = await import("./credentials.js");
  const token = await getCredential("github_token");
  if (!token) return skipped("not_configured");

  // /rate_limit is authenticated, free, and doesn't consume quota.
  const res = await fetch("https://api.github.com/rate_limit", {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Aura",
    },
    signal,
  });
  if (!res.ok) throw new ProbeError(httpReason(res.status));
  return OK;
}

async function probeBigQuery(_signal: AbortSignal): Promise<ProbeOutcome> {
  const { getBigQueryClient } = await import("./bigquery.js");
  const client = await getBigQueryClient();
  if (!client) return skipped("not_configured");

  await client.getDatasets({ maxResults: 1 });
  return OK;
}

async function probeE2B(_signal: AbortSignal): Promise<ProbeOutcome> {
  const { getSandboxEnvs } = await import("./sandbox.js");
  const envs = await getSandboxEnvs("aura");
  const apiKey = envs.E2B_API_KEY;
  if (!apiKey) return skipped("not_configured");

  const { Sandbox } = await import("e2b");
  await Sandbox.list({ apiKey }).nextItems();
  return OK;
}

async function probeAiGateway(signal: AbortSignal): Promise<ProbeOutcome> {
  // Same auth surface the @ai-sdk/gateway provider uses: an explicit API key
  // (AI_GATEWAY_API_KEY, or this repo's VERCEL_AI_GATEWAY_API_KEY for local
  // dev) or the Vercel OIDC token available on deployed functions.
  const bearer =
    process.env.AI_GATEWAY_API_KEY ||
    process.env.VERCEL_AI_GATEWAY_API_KEY ||
    process.env.VERCEL_OIDC_TOKEN;
  if (!bearer) return skipped("not_configured");

  // /v1/credits is a cheap authenticated read (the model list is public, so
  // it wouldn't verify our credentials).
  const res = await fetch("https://ai-gateway.vercel.sh/v1/credits", {
    headers: { Authorization: `Bearer ${bearer}` },
    signal,
  });
  if (!res.ok) throw new ProbeError(httpReason(res.status));
  return OK;
}

async function probeGmail(_signal: AbortSignal): Promise<ProbeOutcome> {
  const { getGmailClient } = await import("./gmail.js");
  const gmail = await getGmailClient();
  if (!gmail) return skipped("not_configured");

  await gmail.users.getProfile({ userId: "me" });
  return OK;
}

async function probeCursor(_signal: AbortSignal): Promise<ProbeOutcome> {
  const { resolveCredentialValue } = await import("./credentials.js");
  const apiKey = await resolveCredentialValue("cursor_api_key");
  if (!apiKey) return skipped("not_configured");

  // Raw v0 REST, not @cursor/sdk: 1.0.30's published dist is unbundlable
  // under the Workflow DevKit esbuild step-discovery pass (dynamic import()
  // of its own .d.ts.map files, plus unresolvable bun:sqlite / vendor /
  // ./errors.js / ./stubs.js references) -- it broke
  // pnpm --filter aura-api build:vercel on main. See cursor-agent.ts for the
  // full writeup. This still catches upstream endpoint/contract drift for
  // the whole integration (#986's original incident was a silent Cursor
  // endpoint rename).
  const res = await fetch("https://api.cursor.com/v0/agents?limit=1", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Cursor API GET /agents failed (${res.status}): ${text}`,
    );
  }
  return OK;
}

export const DEFAULT_PROBES: Record<string, SmokeProbe> = {
  slack: probeSlack,
  github: probeGitHub,
  bigquery: probeBigQuery,
  e2b: probeE2B,
  ai_gateway: probeAiGateway,
  gmail: probeGmail,
  cursor: probeCursor,
};

// ── Runner ──────────────────────────────────────────────────────────────────

async function runProbe(
  integration: string,
  probe: SmokeProbe,
  timeoutMs: number,
): Promise<SmokeCheckResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  (timer as { unref?: () => void }).unref?.();

  try {
    const timeout = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () =>
        reject(new ProbeError("timeout")),
      );
    });
    const outcome = await Promise.race([probe(controller.signal), timeout]);
    return {
      integration,
      status: outcome.status,
      latencyMs: Date.now() - started,
      ...(outcome.status === "skipped" ? { reason: outcome.reason } : {}),
    };
  } catch (error) {
    return {
      integration,
      status: "failed",
      latencyMs: Date.now() - started,
      reason: sanitizeError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run all smoke probes in parallel and aggregate a report. `probes` and
 * `timeoutMs` are injectable for tests.
 */
export async function runSmokeChecks(
  probes: Record<string, SmokeProbe> = DEFAULT_PROBES,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<SmokeReport> {
  const started = Date.now();

  const checks = await Promise.all(
    Object.entries(probes).map(([integration, probe]) =>
      runProbe(integration, probe, timeoutMs),
    ),
  );

  const report: SmokeReport = {
    ok: checks.every((check) => check.status !== "failed"),
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - started,
    checks,
  };

  logger.info("smoke check completed", {
    ok: report.ok,
    durationMs: report.durationMs,
    summary: checks.map((c) => `${c.integration}:${c.status}`).join(","),
  });

  return report;
}

import { getSetting, setSetting } from "./settings.js";
import { logger } from "./logger.js";

const SANDBOX_NOTE_KEY = "e2b_sandbox_id";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Per-invocation cache -- reuse the same sandbox within a single request */
let cachedSandbox: any | null = null;

/**
 * Dynamically import the E2B SDK to avoid ESM/CJS compatibility issues.
 * The variable-based import prevents Vercel's bundler (nft) from
 * statically resolving and inlining the e2b package, which would
 * cause chalk (ESM-only) to crash the CJS runtime.
 */
async function loadE2B() {
  // Variable indirection prevents bundler from tracing this import
  const pkg = "e2b";
  const mod = await import(/* webpackIgnore: true */ pkg);
  return mod.Sandbox;
}

/**
 * Get or create a sandbox. Tries to resume a previously paused sandbox,
 * creates a new one if none exists or resume fails.
 */
export async function getOrCreateSandbox(): Promise<any> {
  // Return cached instance within the same invocation
  if (cachedSandbox) {
    try {
      // Reset timeout to keep it alive
      await cachedSandbox.setTimeout(DEFAULT_TIMEOUT_MS);
      return cachedSandbox;
    } catch {
      cachedSandbox = null;
    }
  }

  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) {
    throw new Error(
      "E2B_API_KEY is not configured. Sandbox execution is not available.",
    );
  }

  const Sandbox = await loadE2B();

  // Try to resume a previously paused sandbox
  const savedId = await getSetting(SANDBOX_NOTE_KEY);
  if (savedId) {
    try {
      logger.info("Resuming E2B sandbox", { sandboxId: savedId });
      const sandbox = await Sandbox.connect(savedId, {
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      cachedSandbox = sandbox;
      logger.info("E2B sandbox resumed", { sandboxId: savedId });
      return sandbox;
    } catch (error: any) {
      logger.warn("Failed to resume sandbox, creating new one", {
        savedId,
        error: error.message,
      });
    }
  }

  // Create a new sandbox
  const templateId = process.env.E2B_TEMPLATE_ID || undefined;
  logger.info("Creating new E2B sandbox", { templateId: templateId || "default" });

  const createOptions: any = { timeoutMs: DEFAULT_TIMEOUT_MS };
  const sandbox = templateId
    ? await Sandbox.create(templateId, createOptions)
    : await Sandbox.create(createOptions);

  // Save the sandbox ID for future resumption
  await setSetting(SANDBOX_NOTE_KEY, sandbox.sandboxId, "aura");

  cachedSandbox = sandbox;
  logger.info("E2B sandbox created", { sandboxId: sandbox.sandboxId });

  return sandbox;
}

/**
 * Pause the sandbox to save credits. The sandbox state (filesystem, memory)
 * is preserved and can be resumed later.
 */
export async function pauseSandbox(): Promise<void> {
  if (!cachedSandbox) return;

  try {
    const sandboxId = cachedSandbox.sandboxId;
    await cachedSandbox.betaPause();
    // Save the sandbox ID so we can resume it later
    await setSetting(SANDBOX_NOTE_KEY, sandboxId, "aura");
    logger.info("E2B sandbox paused", { sandboxId });
  } catch (error: any) {
    logger.warn("Failed to pause sandbox", { error: error.message });
  } finally {
    cachedSandbox = null;
  }
}

/**
 * Truncate shell output to avoid token bloat.
 * Preserves the beginning (headers, command echo) and end (results, errors).
 */
export function truncateOutput(
  output: string,
  maxChars = 4000,
): string {
  if (output.length <= maxChars) return output;
  const half = Math.floor(maxChars / 2);
  return (
    output.slice(0, half) +
    "\n\n...(truncated " +
    (output.length - maxChars) +
    " chars)...\n\n" +
    output.slice(-half)
  );
}

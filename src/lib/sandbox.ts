import { getSetting, setSetting } from "./settings.js";
import { getCredential } from "./credentials.js";
import { logger } from "./logger.js";

const SANDBOX_NOTE_KEY = "e2b_sandbox_id";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Per-invocation cache -- reuse the same sandbox within a single request */
let cachedSandbox: any | null = null;

/**
 * Clear the cached sandbox reference so the next call to
 * getOrCreateSandbox() creates a fresh instance. Call this when a
 * sandbox becomes unresponsive (e.g. after a command timeout).
 */
export function clearCachedSandbox(): void {
  if (cachedSandbox) {
    logger.info("Clearing cached sandbox reference", {
      sandboxId: cachedSandbox.sandboxId,
    });
    cachedSandbox = null;
  }
}

/**
 * Dynamically import the E2B SDK.
 * Kept as dynamic import so the module only loads when sandbox
 * tools are actually called (not on every cold start).
 */
async function loadE2B() {
  const { Sandbox } = await import("e2b");
  return Sandbox;
}

/**
 * Build the env vars map from the current Vercel process environment.
 * Callers should pass this to every `commands.run({ envs })` call so
 * env vars are always fresh — regardless of whether the sandbox was
 * just created or resumed from a paused state.
 *
 * E2B's `Sandbox.connect()` does NOT restore the `envs` that were
 * passed at creation time, and persistence across pause/resume is
 * unreliable (see e2b-dev/E2B#884). Per-command `envs` is the only
 * mechanism that works consistently.
 */
export async function getSandboxEnvs(): Promise<Record<string, string>> {
  const envs: Record<string, string> = {};
  const ghToken = await getCredential("github_token");
  if (ghToken) {
    envs.GITHUB_TOKEN = ghToken;
    envs.GH_TOKEN = ghToken;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.DATABASE_URL) {
    envs.DATABASE_URL = process.env.DATABASE_URL;
  }
  if (process.env.VERCEL_TOKEN) {
    envs.VERCEL_TOKEN = process.env.VERCEL_TOKEN;
  }
  if (process.env.OPENAI_API_KEY) {
    envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }
  if (process.env.SLACK_BOT_TOKEN) {
    envs.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  }
  return envs;
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
  const envs = await getSandboxEnvs();

  // Try to resume a previously paused sandbox
  const savedId = await getSetting(SANDBOX_NOTE_KEY);
  if (savedId) {
    try {
      logger.info("Resuming E2B sandbox", { sandboxId: savedId });
      const sandbox = await Sandbox.connect(savedId, {
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      // Health check: verify the sandbox is actually responsive
      const healthCheck = await sandbox.commands.run("echo ok", {
        timeoutMs: 5_000,
      });
      if (healthCheck.exitCode !== 0) {
        throw new Error("Health check failed after resume");
      }

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

  // Create a new sandbox (pass envs as a convenience for manual processes)
  const templateId = process.env.E2B_TEMPLATE_ID || undefined;
  logger.info("Creating new E2B sandbox", { templateId: templateId || "default" });

  const createOptions: any = { timeoutMs: DEFAULT_TIMEOUT_MS, envs };
  const sandbox = templateId
    ? await Sandbox.create(templateId, createOptions)
    : await Sandbox.create(createOptions);

  // Save the sandbox ID for future resumption
  await setSetting(SANDBOX_NOTE_KEY, sandbox.sandboxId, "aura");

  cachedSandbox = sandbox;
  logger.info("E2B sandbox created", { sandboxId: sandbox.sandboxId });

  // Install Claude Code if not already present (persists across pause/resume)
  try {
    const check = await sandbox.commands.run("which claude", {
      timeoutMs: 5_000,
      envs,
    });
    if (check.exitCode !== 0) {
      logger.info("Installing Claude Code in sandbox");
      const installResult = await sandbox.commands.run(
        "npm install -g @anthropic-ai/claude-code",
        { timeoutMs: 120_000, envs },
      );
      if (installResult.exitCode !== 0) {
        logger.warn("Claude Code install failed", {
          exitCode: installResult.exitCode,
          stderr: installResult.stderr,
        });
      } else {
        logger.info("Claude Code installed in sandbox");
      }
    }
  } catch (error: any) {
    logger.warn("Failed to install Claude Code in sandbox", {
      error: error.message,
    });
  }

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
    throw error;
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

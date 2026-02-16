import { getSetting, setSetting } from "./settings.js";
import { logger } from "./logger.js";

const SANDBOX_NOTE_KEY = "e2b_sandbox_id";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Per-invocation cache -- reuse the same sandbox within a single request */
let cachedSandbox: any | null = null;

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

  // Env vars to inject into the sandbox
  const envs: Record<string, string> = {};
  if (process.env.GITHUB_TOKEN) {
    envs.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    envs.GH_TOKEN = process.env.GITHUB_TOKEN;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }

  // Try to resume a previously paused sandbox
  const savedId = await getSetting(SANDBOX_NOTE_KEY);
  if (savedId) {
    try {
      logger.info("Resuming E2B sandbox", { sandboxId: savedId });
      const sandbox = await Sandbox.connect(savedId, {
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      // Inject env vars into resumed sandbox (connect() doesn't support envs)
      if (Object.keys(envs).length > 0) {
        const exports = Object.entries(envs)
          .map(([k, v]) => `export ${k}="${v}"`)
          .join(" && ");
        await sandbox.commands.run(`${exports} && echo 'env set'`, {
          cwd: "/home/user",
          timeoutMs: 5000,
        });

        // Also write to .bashrc so env persists across commands
        const bashrcLines = Object.entries(envs)
          .map(([k, v]) => `export ${k}="${v}"`)
          .join("\n");
        await sandbox.files.write("/home/user/.env_injected", bashrcLines);
        await sandbox.commands.run(
          'grep -q env_injected /home/user/.bashrc || echo "source /home/user/.env_injected" >> /home/user/.bashrc',
          { cwd: "/home/user", timeoutMs: 5000 },
        );
      }

      cachedSandbox = sandbox;
      logger.info("E2B sandbox resumed with env vars", { sandboxId: savedId });
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

  const createOptions: any = { timeoutMs: DEFAULT_TIMEOUT_MS, envs };
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

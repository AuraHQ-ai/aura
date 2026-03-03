import * as nodePath from "node:path";
import { getSetting, setSetting } from "./settings.js";
import { getCredential } from "./credentials.js";
import { logger } from "./logger.js";

const sandboxNoteKey = (userId?: string) =>
  userId ? `e2b_sandbox_id:${userId}` : "e2b_sandbox_id";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

/** Per-invocation cache -- reuse the same sandbox within a single request */
let cachedSandbox: any | null = null;
let cachedSandboxUserId: string | undefined;

/**
 * Clear the cached sandbox reference so the next call to
 * getOrCreateSandbox() creates a fresh instance. Only call this when
 * Sandbox.connect() actually fails — NOT on command timeouts (a slow
 * sandbox is not a dead sandbox).
 */
export function clearCachedSandbox(reason?: string): void {
  if (cachedSandbox) {
    logger.info("Clearing cached sandbox reference", {
      sandboxId: cachedSandbox.sandboxId,
      reason: reason ?? "unknown",
    });
    cachedSandbox = null;
    cachedSandboxUserId = undefined;
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
  if (process.env.POSTHOG_API_KEY) {
    envs.POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;
  }
  if (process.env.CLAAP_API_KEY) {
    envs.CLAAP_API_KEY = process.env.CLAAP_API_KEY;
  }
  const saKeyB64 =
    process.env.GOOGLE_SA_KEY_B64 ||
    (process.env.GOOGLE_SERVICE_ACCOUNT_KEY
      ? Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY).toString("base64")
      : undefined);
  if (saKeyB64) {
    envs.GOOGLE_SA_KEY_B64 = saKeyB64;
  }
  return envs;
}

/**
 * Mount the GCS bucket `gs://aura-files` at `/mnt/aura-files`.
 * Installs gcsfuse if needed and uses the base64-encoded SA key from envs.
 * Non-fatal -- sandbox works fine without the mount.
 */
async function setupSandboxFilesystem(
  sandbox: any,
  envs: Record<string, string>,
): Promise<void> {
  try {
    const mountCheck = await sandbox.commands.run(
      "mountpoint -q /mnt/aura-files && echo mounted || echo not",
      { timeoutMs: 5_000, envs },
    );
    if (mountCheck.stdout?.trim() === "mounted") return;

    if (!envs.GOOGLE_SA_KEY_B64) {
      logger.info("Skipping GCS mount — GOOGLE_SA_KEY_B64 not available");
      return;
    }

    const gcsfuseCheck = await sandbox.commands.run("which gcsfuse", {
      timeoutMs: 5_000,
    });
    if (gcsfuseCheck.exitCode !== 0) {
      const distro = "bookworm";
      const installResult = await sandbox.commands.run(
        `echo "deb [signed-by=/usr/share/keyrings/cloud.google.asc] https://packages.cloud.google.com/apt gcsfuse-${distro} main" | sudo tee /etc/apt/sources.list.d/gcsfuse.list && curl -s https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo tee /usr/share/keyrings/cloud.google.asc > /dev/null && sudo apt-get update -qq && sudo apt-get install -y -qq gcsfuse`,
        { timeoutMs: 60_000, envs },
      );
      if (installResult.exitCode !== 0) {
        logger.warn("gcsfuse install failed", {
          exitCode: installResult.exitCode,
          stderr: installResult.stderr,
        });
        return;
      }
    }

    const mountResult = await sandbox.commands.run(
      `touch /tmp/gcs-sa-key.json && chmod 600 /tmp/gcs-sa-key.json && echo "$GOOGLE_SA_KEY_B64" | base64 -d > /tmp/gcs-sa-key.json && sudo mkdir -p /mnt/aura-files && gcsfuse --key-file=/tmp/gcs-sa-key.json --implicit-dirs aura-files /mnt/aura-files; EXIT=$?; rm -f /tmp/gcs-sa-key.json; exit $EXIT`,
      { timeoutMs: 30_000, envs },
    );
    if (mountResult.exitCode !== 0) {
      logger.warn("gcsfuse mount failed", {
        exitCode: mountResult.exitCode,
        stderr: mountResult.stderr,
      });
      return;
    }
    logger.info("GCS bucket mounted at /mnt/aura-files");
  } catch (error: any) {
    logger.warn("Failed to mount GCS bucket", { error: error.message });
  }
}

/**
 * Get or create a sandbox. Tries to resume a previously paused sandbox
 * (autoPause handles lifecycle), creates a new one if none exists or
 * resume fails. Pass userId for per-user sandbox isolation.
 */
export async function getOrCreateSandbox(userId?: string): Promise<any> {
  // Return cached instance within the same invocation (must match userId)
  if (cachedSandbox && cachedSandboxUserId === userId) {
    try {
      await cachedSandbox.setTimeout(DEFAULT_TIMEOUT_MS);
      return cachedSandbox;
    } catch {
      cachedSandbox = null;
      cachedSandboxUserId = undefined;
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
  const noteKey = sandboxNoteKey(userId);

  // Try to resume a previously paused sandbox
  const savedId = await getSetting(noteKey);
  if (savedId) {
    try {
      logger.info("Resuming E2B sandbox", { sandboxId: savedId, userId });
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
      cachedSandboxUserId = userId;
      logger.info("E2B sandbox resumed", { sandboxId: savedId, userId });
    } catch (error: any) {
      logger.warn("Failed to resume sandbox, creating new one", {
        savedId,
        userId,
        error: error.message,
      });
      clearCachedSandbox("connect_failed");
    }

    if (cachedSandbox) {
      await setupSandboxFilesystem(cachedSandbox, envs);
      return cachedSandbox;
    }
  }

  // Create a new sandbox with autoPause so e2b handles its own lifecycle
  const templateId = process.env.E2B_TEMPLATE_ID || undefined;
  logger.info("Creating new E2B sandbox", { templateId: templateId || "default", userId });

  const createOptions: any = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    autoPause: true,
    envs,
  };
  const sandbox = templateId
    ? await Sandbox.create(templateId, createOptions)
    : await Sandbox.create(createOptions);

  // Save the sandbox ID for future resumption
  await setSetting(noteKey, sandbox.sandboxId, "aura");

  cachedSandbox = sandbox;
  cachedSandboxUserId = userId;
  logger.info("E2B sandbox created", { sandboxId: sandbox.sandboxId, userId });

  // Ensure the downloads directory exists for file-to-disk tools
  try {
    await sandbox.commands.run("mkdir -p /home/user/downloads", {
      timeoutMs: 5_000,
      envs,
    });
  } catch {
    logger.warn("Failed to create /home/user/downloads in sandbox");
  }

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

  await setupSandboxFilesystem(sandbox, envs);

  return sandbox;
}

/**
 * Write binary data (as a Buffer) to the sandbox filesystem.
 * Creates parent directories if needed.
 * Returns the absolute path where the file was saved.
 */
export async function writeToSandbox(
  filename: string,
  data: Buffer,
  subdir: string = "downloads",
): Promise<string> {
  const sandbox = await getOrCreateSandbox();
  const dir = `/home/user/${subdir}`;
  await sandbox.commands.run(`mkdir -p "${dir}"`, { timeoutMs: 5_000 });
  const safeName = nodePath.basename(filename);
  const path = `${dir}/${safeName}`;
  await sandbox.files.write(path, data);
  return path;
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

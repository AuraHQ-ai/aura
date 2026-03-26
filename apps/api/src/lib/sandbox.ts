import * as nodePath from "node:path";
import { getSetting, setSetting } from "./settings.js";
import { decryptCredential } from "./credentials.js";
import { db } from "../db/client.js";
import { credentials, credentialGrants } from "@aura/db/schema";
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
  userHomeReady.clear();
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
 * Build the env vars map for sandbox commands from the credentials DB.
 *
 * Resolves which credentials the user can access, decrypts them, and
 * returns a flat NAME → value map. Uses `sandboxEnvName` when set on the
 * credential row, otherwise falls back to uppercasing the credential name.
 *
 * Owner-aware: for `owner` scoped credentials, only the calling user's
 * row is injected. This prevents collisions when multiple users store a
 * credential with the same name (e.g. `github_token`).
 *
 * Must be passed to every `commands.run({ envs })` call — E2B does NOT
 * persist envs across pause/resume (see e2b-dev/E2B#884).
 */
export async function getSandboxEnvs(userId?: string): Promise<Record<string, string>> {
  const envs: Record<string, string> = {};

  let userCredNames: Set<string> | null = null;
  if (userId) {
    try {
      const { resolveUserCredentials } = await import("./permissions.js");
      userCredNames = await resolveUserCredentials(userId);
    } catch (e: any) {
      logger.warn("getSandboxEnvs: credential resolution failed", {
        userId,
        error: e.message,
      });
      return envs;
    }
  }

  try {
    // Resolve explicit credential grants so Gate 2 can allow owner-scoped
    // credentials the caller doesn't own but was explicitly granted.
    const grantedCredentialIds = new Set<string>();
    if (userId) {
      const { eq, and, isNull } = await import("drizzle-orm");
      const grants = await db
        .select({ credentialId: credentialGrants.credentialId })
        .from(credentialGrants)
        .where(
          and(
            eq(credentialGrants.granteeId, userId),
            isNull(credentialGrants.revokedAt),
          ),
        );
      for (const g of grants) grantedCredentialIds.add(g.credentialId);
    }

    const rows = await db
      .select({
        id: credentials.id,
        name: credentials.name,
        value: credentials.value,
        ownerId: credentials.ownerId,
        scope: credentials.scope,
        sandboxEnvName: credentials.sandboxEnvName,
      })
      .from(credentials);

    for (const row of rows) {
      // Gate 1: user must have access to this credential name
      if (userCredNames && !userCredNames.has(row.name)) continue;

      // Gate 2: for owner-scoped credentials, only inject the calling user's
      // own row OR rows they've been explicitly granted access to.
      // Without this, two users with the same credential name (e.g.
      // `github_token`) would collide and the last row wins silently.
      // When userId is omitted, skip ALL owner-scoped credentials to prevent
      // leaking every user's secrets into an anonymous sandbox.
      if (row.scope === "owner") {
        if (!userId) continue;
        if (row.ownerId !== userId && !grantedCredentialIds.has(row.id)) continue;
      }

      // Use the explicit sandboxEnvName if set, otherwise uppercase the name
      const envName = row.sandboxEnvName || row.name.toUpperCase();
      try {
        envs[envName] = decryptCredential(row.value);
      } catch (e: any) {
        logger.warn("Failed to decrypt credential for sandbox injection", {
          name: row.name,
          envName,
          error: e.message,
        });
      }
    }
  } catch (e: any) {
    logger.warn("Failed to query credentials for sandbox injection", { error: e.message });
  }

  if (envs.GITHUB_TOKEN && !envs.GH_TOKEN) {
    envs.GH_TOKEN = envs.GITHUB_TOKEN;
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
        `echo "deb [signed-by=/usr/share/keyrings/cloud.google.asc] https://packages.cloud.google.com/apt gcsfuse-${distro} main" | sudo tee /etc/apt/sources.list.d/gcsfuse.list && curl -s https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo tee /usr/share/keyrings/cloud.google.asc > /dev/null && sudo apt-get update -qq && sudo apt-get install -y -qq gcsfuse && { grep -q user_allow_other /etc/fuse.conf 2>/dev/null || echo user_allow_other | sudo tee -a /etc/fuse.conf > /dev/null; }`,
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
      `touch /tmp/gcs-sa-key.json && chmod 600 /tmp/gcs-sa-key.json && echo "$GOOGLE_SA_KEY_B64" | base64 -d > /tmp/gcs-sa-key.json && sudo mkdir -p /mnt/aura-files && sudo chown 1000:1000 /mnt/aura-files && sudo gcsfuse --key-file=/tmp/gcs-sa-key.json --implicit-dirs --uid=1000 --gid=1000 -o allow_other aura-files /mnt/aura-files; EXIT=$?; rm -f /tmp/gcs-sa-key.json; exit $EXIT`,
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
 * Ensure per-user persistent home directory exists on the GCS mount.
 * Creates directory structure and symlinks on first call per user per session.
 * Falls back gracefully if GCS mount is unavailable.
 */
const userHomeReady = new Set<string>();

export async function ensureUserHome(
  sandbox: any,
  userId: string,
  envs: Record<string, string>,
): Promise<string> {
  const fallback = "/home/user";
  if (!userId || userId === "aura") return fallback;

  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
    logger.warn("Invalid userId rejected by ensureUserHome", { userId });
    return fallback;
  }

  if (userHomeReady.has(userId)) {
    return `/mnt/aura-files/users/${userId}`;
  }

  try {
    const mountCheck = await sandbox.commands.run(
      "mountpoint -q /mnt/aura-files && echo mounted || echo not",
      { timeoutMs: 5_000, envs },
    );
    if (mountCheck.stdout?.trim() !== "mounted") {
      logger.info("GCS not mounted, falling back to /home/user", { userId });
      return fallback;
    }

    const userHome = `/mnt/aura-files/users/${userId}`;

    const mkdirResult = await sandbox.commands.run(
      `mkdir -p "${userHome}"/{downloads,repos,projects}`,
      { timeoutMs: 10_000, envs },
    );
    if (mkdirResult.exitCode !== 0) {
      logger.warn("Failed to create per-user home directories", {
        userId,
        exitCode: mkdirResult.exitCode,
        stderr: mkdirResult.stderr,
      });
      return fallback;
    }

    userHomeReady.add(userId);
    logger.info("Per-user home ready", { userId, userHome });
    return userHome;
  } catch (error: any) {
    logger.warn("Failed to set up per-user home, using fallback", {
      userId,
      error: error.message,
    });
    return fallback;
  }
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
      userHomeReady.clear();
    }
  }

  const Sandbox = await loadE2B();
  const envs = await getSandboxEnvs("aura");

  const apiKey = envs.E2B_API_KEY;
  if (!apiKey) {
    throw new Error(
      "E2B_API_KEY is not configured. Add it as a credential in the dashboard.",
    );
  }

  // Try to resume a previously paused sandbox
  const savedId = await getSetting(SANDBOX_NOTE_KEY);
  if (savedId) {
    try {
      logger.info("Resuming E2B sandbox", { sandboxId: savedId });
      const sandbox = await Sandbox.connect(savedId, {
        apiKey,
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
    } catch (error: any) {
      logger.warn("Failed to resume sandbox, creating new one", {
        savedId,
        error: error.message,
      });
    }

    if (cachedSandbox) {
      await setupSandboxFilesystem(cachedSandbox, envs);
      return cachedSandbox;
    }
  }

  // Create a new sandbox
  const templateId = envs.E2B_TEMPLATE_ID || process.env.E2B_TEMPLATE_ID || undefined;
  logger.info("Creating new E2B sandbox", { templateId: templateId || "default" });

  const createOptions: any = { apiKey, timeoutMs: DEFAULT_TIMEOUT_MS };
  const sandbox = templateId
    ? await Sandbox.create(templateId, createOptions)
    : await Sandbox.create(createOptions);

  // Save the sandbox ID for future resumption
  await setSetting(SANDBOX_NOTE_KEY, sandbox.sandboxId, "aura");

  cachedSandbox = sandbox;
  logger.info("E2B sandbox created", { sandboxId: sandbox.sandboxId });

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
    userHomeReady.clear();
  }
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
  userId?: string,
): Promise<string> {
  const sandbox = await getOrCreateSandbox();

  let base = "/home/user";
  if (userId) {
    const envs = await getSandboxEnvs(userId);
    base = await ensureUserHome(sandbox, userId, envs);
  }

  const dir = `${base}/${subdir}`;
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

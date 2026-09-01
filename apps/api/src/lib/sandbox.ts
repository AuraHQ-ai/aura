import * as nodePath from "node:path";
import { getSetting, setSetting } from "./settings.js";
import { decryptCredential } from "./credentials.js";
import { executionContext } from "./tool.js";
import { db } from "../db/client.js";
import { credentials, credentialGrants, users } from "@aura/db/schema";
import { logger } from "./logger.js";
import { recordError } from "./metrics.js";

const sandboxNoteKey = (userId?: string) =>
  userId ? `e2b_sandbox_id:${userId}` : "e2b_sandbox_id";
const sandboxTemplateKey = (userId?: string) =>
  userId ? `e2b_sandbox_template_id:${userId}` : "e2b_sandbox_template_id";
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour -- autoPause handles inactivity
const TOOLS_REPO_SETTING_KEY = "tools_repo";

// Background-command bookkeeping dir (mirrors BACKGROUND_COMMAND_DIR in tools/sandbox.ts).
// The launcher writes ~7 files per command here; without pruning it accumulates tens of
// thousands of stale files over the lifetime of a long-lived sandbox.
const BACKGROUND_COMMAND_DIR = "/tmp/aura-bg";

// Disk-space self-heal thresholds for the persistent per-user sandbox. The root
// filesystem is ~11 GiB; over weeks the pnpm store, package caches, repo checkouts and
// /tmp bookkeeping fill it to 100%, after which every command fails at launch with
// "No space left on device" (it can't even write the launcher script). On resume we
// reclaim space when free disk drops below SOFT, and recreate the sandbox from scratch
// if reclaim can't get it back above HARD.
const DISK_RECLAIM_SOFT_KB = 1.5 * 1024 * 1024; // < 1.5 GiB free -> run reclaim
const DISK_RECLAIM_HARD_KB = 512 * 1024; // < 512 MiB free after reclaim -> recreate

// Best-effort, non-destructive disk reclamation. Only removes regenerable caches,
// unreferenced pnpm store entries, apt artifacts, and stale background-command files.
// User data under /home/user (repos, projects) and the GCS mount are left untouched.
const DISK_RECLAIM_SCRIPT = [
  "set +e",
  `find ${BACKGROUND_COMMAND_DIR} -maxdepth 1 -type f -mmin +720 -delete 2>/dev/null`,
  `rm -rf "$HOME/.cache/pip" "$HOME/.cache/pnpm" "$HOME/.cache/node" "$HOME/.cache/uv" "$HOME/.cache/ms-playwright" "$HOME/.cache/puppeteer" "$HOME/.npm/_cacache" 2>/dev/null`,
  "if command -v pnpm >/dev/null 2>&1; then pnpm store prune >/dev/null 2>&1; fi",
  "if command -v npm >/dev/null 2>&1; then npm cache clean --force >/dev/null 2>&1; fi",
  "sudo apt-get clean >/dev/null 2>&1",
  "sudo rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb /var/log/*.gz /var/log/*.1 2>/dev/null",
  "true",
].join("\n");

const TOOLS_REPO_CHECKOUT_DIR_NAME = ["aura", "tools"].join("-");
const TOOLS_REPO_CHECKOUT_PATH = `/home/user/${TOOLS_REPO_CHECKOUT_DIR_NAME}`;

// Self-authored tools live in this repo by default (issue #960). A workspace
// can override it via the `tools_repo` setting, but the checkout must exist on
// every sandbox acquisition — recurring jobs invoke tools via
// `python3 /home/user/aura-tools/runner.py <tool> '{...}'` and die silently
// when a recycled sandbox comes back without it.
const AURA_TOOLS_DEFAULT_REPO = "realadvisor/aura-tools";

// Marker file touched after a successful sync. When it is younger than
// AURA_TOOLS_FRESH_MINUTES the entire bootstrap is a single cheap probe —
// no git network round-trip — so sandbox startup is not measurably slowed.
const AURA_TOOLS_SYNC_MARKER_PATH = `${TOOLS_REPO_CHECKOUT_PATH}/.aura-tools-synced`;
const AURA_TOOLS_FRESH_MINUTES = 30;

/** Sandbox ids already synced by this process (mirrors userHomeReady). */
const auraToolsReady = new Set<string>();

/** Per-invocation cache -- reuse the same sandbox within a single request.
 *  Keyed by userId so concurrent invocations for different users don't share state. */
let cachedSandbox: any | null = null;
let cachedSandboxUserId: string | undefined;

interface SandboxCredentialRow {
  id: string;
  name: string;
  ownerId: string;
  scope: string;
  sandboxEnvName: string | null;
}

interface SandboxCredentialValueRow extends SandboxCredentialRow {
  value: string;
}

interface SandboxCommandRunner {
  commands: {
    run: (
      command: string,
      options?: { timeoutMs?: number; envs?: Record<string, string> },
    ) => Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
  };
}

interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a sandbox command, tolerating non-zero exit codes.
 *
 * The E2B SDK's `commands.run()` THROWS `CommandExitError` on any non-zero
 * exit instead of returning a result — so `if (result.exitCode !== 0)`
 * branches after a bare `run()` are unreachable. This helper converts a
 * thrown `CommandExitError` (recognized structurally by its numeric
 * `exitCode`) back into a `{ exitCode, stdout, stderr }` result so callers
 * can branch on the exit code. Genuine transport/connection errors carry no
 * exit code and are re-thrown untouched.
 */
async function runTolerant(
  sandbox: SandboxCommandRunner,
  command: string,
  options?: { timeoutMs?: number; envs?: Record<string, string> },
): Promise<SandboxCommandResult> {
  try {
    const result = await sandbox.commands.run(command, options);
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (error: any) {
    if (error && typeof error.exitCode === "number") {
      return {
        exitCode: error.exitCode,
        stdout: typeof error.stdout === "string" ? error.stdout : "",
        stderr: typeof error.stderr === "string" ? error.stderr : "",
      };
    }
    throw error;
  }
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeToolsRepo(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let ownerAndRepo = trimmed;
  if (/^https:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.hostname.toLowerCase() !== "github.com") return null;
      ownerAndRepo = url.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  }

  ownerAndRepo = ownerAndRepo.replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = ownerAndRepo.split("/");
  if (parts.length !== 2) return null;

  const [owner, repo] = parts;
  const segmentPattern = /^[A-Za-z0-9_.-]+$/;
  if (!segmentPattern.test(owner) || !segmentPattern.test(repo)) return null;

  return `${owner}/${repo}`;
}

function redactGitAuth(stderr?: string): string | undefined {
  return stderr?.replace(
    /x-access-token:[^@\s]+@/g,
    "x-access-token:[REDACTED]@",
  );
}

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
    cachedSandboxUserId = undefined;
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
 * Return free space on the sandbox root filesystem in KiB, or null if it
 * can't be measured (in which case callers must not take destructive action).
 */
async function getRootDiskAvailKB(
  sandbox: any,
  envs: Record<string, string>,
): Promise<number | null> {
  try {
    const result = await runTolerant(sandbox, "df -kP / | awk 'NR==2 {print $4}'", {
      timeoutMs: 8_000,
      envs,
    });
    if (result.exitCode !== 0) return null;
    const kb = Number.parseInt((result.stdout || "").trim(), 10);
    return Number.isFinite(kb) ? kb : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort reclamation of regenerable disk space (caches, pnpm store,
 * apt artifacts, stale /tmp/aura-bg bookkeeping). Never touches user data.
 * Exported for reuse/testing.
 */
export async function reclaimSandboxDiskSpace(
  sandbox: any,
  envs: Record<string, string>,
): Promise<void> {
  try {
    await runTolerant(sandbox, DISK_RECLAIM_SCRIPT, { timeoutMs: 120_000, envs });
  } catch (error: any) {
    logger.warn("Sandbox disk reclaim command failed", { error: error.message });
  }
}

/**
 * Ensure the resumed sandbox has usable disk space. Reclaims regenerable space
 * when free disk is low and reports whether the sandbox is usable afterwards.
 * Returns false only when, after reclaiming, free space is still critically low
 * (the caller should then recreate the sandbox from scratch).
 */
async function ensureSandboxDiskSpace(
  sandbox: any,
  envs: Record<string, string>,
): Promise<boolean> {
  const availBefore = await getRootDiskAvailKB(sandbox, envs);
  if (availBefore === null) return true; // can't measure -> don't destroy a working sandbox
  if (availBefore >= DISK_RECLAIM_SOFT_KB) return true;

  logger.warn("Sandbox low on disk, reclaiming space", {
    availMB: Math.round(availBefore / 1024),
  });
  await reclaimSandboxDiskSpace(sandbox, envs);

  const availAfter = await getRootDiskAvailKB(sandbox, envs);
  logger.info("Sandbox disk reclaim complete", {
    beforeMB: Math.round(availBefore / 1024),
    afterMB: availAfter === null ? null : Math.round(availAfter / 1024),
  });
  if (availAfter === null) return true;
  return availAfter >= DISK_RECLAIM_HARD_KB;
}

function resolveSandboxEnvName(row: SandboxCredentialRow): string {
  return row.sandboxEnvName || row.name.toUpperCase();
}

// ── Env allowlist (scoped job execution) ─────────────────────────────────────

/**
 * Env vars the sandbox runtime itself needs (sandbox creation/resume, GCS
 * mount). These always pass through an allowlist filter — without them a
 * scoped job couldn't even boot its sandbox.
 */
export const CORE_SANDBOX_ENV_NAMES = [
  "E2B_API_KEY",
  "E2B_TEMPLATE_ID",
  "GOOGLE_SA_KEY_B64",
] as const;

/**
 * Restrict an env map to the given allowlist of credential env names (matched
 * case-insensitively) plus core infra vars. Narrows only — names on the
 * allowlist that aren't in the map are NOT added. A null/undefined allowlist
 * returns the map unchanged (full inheritance, today's behavior).
 */
export function filterEnvsByAllowlist(
  envs: Record<string, string>,
  allowlist: string[] | null | undefined,
): Record<string, string> {
  if (allowlist == null) return envs;

  const allowed = new Set<string>(
    [...allowlist, ...CORE_SANDBOX_ENV_NAMES].map((name) => name.toUpperCase()),
  );
  // GITHUB_TOKEN is aliased to GH_TOKEN for the gh CLI — allow the alias
  // whenever the canonical name is allowed (and vice versa).
  if (allowed.has("GITHUB_TOKEN")) allowed.add("GH_TOKEN");
  if (allowed.has("GH_TOKEN")) allowed.add("GITHUB_TOKEN");

  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(envs)) {
    if (allowed.has(name.toUpperCase())) {
      filtered[name] = value;
    }
  }
  return filtered;
}

/**
 * Restrict a set of credential *names* to those whose sandbox env name (or
 * uppercased credential name) appears in the given allowlist. Mirrors
 * filterEnvsByAllowlist(): core infra vars always pass, matching is
 * case-insensitive, and GITHUB_TOKEN/GH_TOKEN alias each other.
 *
 * Used to gate credential-backed typed tools (bq_execute_query, Gmail tools,
 * web_search, …) the same way sandbox env vars are gated (issue #1312): a
 * job's env_allowlist must narrow EVERY credential-resolution path, not just
 * `run_command` envs. Narrows only — a null/undefined allowlist returns the
 * set unchanged.
 */
export function filterCredentialNamesByEnvAllowlist(
  credentialNames: ReadonlySet<string>,
  allowlist: readonly string[] | null | undefined,
  /** Credential name → explicit sandbox env name (credentials.sandbox_env_name). */
  envNameByCredential?: ReadonlyMap<string, string>,
): Set<string> {
  if (allowlist == null) return new Set(credentialNames);

  const allowed = new Set(
    [...allowlist, ...CORE_SANDBOX_ENV_NAMES].map((name) => name.toUpperCase()),
  );
  if (allowed.has("GITHUB_TOKEN")) allowed.add("GH_TOKEN");
  if (allowed.has("GH_TOKEN")) allowed.add("GITHUB_TOKEN");

  const filtered = new Set<string>();
  for (const name of credentialNames) {
    const envName = (envNameByCredential?.get(name) || name).toUpperCase();
    if (allowed.has(envName) || allowed.has(name.toUpperCase())) {
      filtered.add(name);
    }
  }
  return filtered;
}

/**
 * Read the env allowlist for the current execution from AsyncLocalStorage.
 * Set by executeJob for jobs with an `env_allowlist`; undefined everywhere
 * else (interactive turns, unscoped jobs) — meaning full inheritance.
 */
function getActiveEnvAllowlist(): string[] | undefined {
  return executionContext.getStore()?.envAllowlist;
}

async function resolveSandboxCredentialRows(
  userId: string | undefined,
  includeValue: true,
): Promise<SandboxCredentialValueRow[]>;
async function resolveSandboxCredentialRows(
  userId?: string,
  includeValue?: false,
): Promise<SandboxCredentialRow[]>;
async function resolveSandboxCredentialRows(
  userId?: string,
  includeValue = false,
): Promise<SandboxCredentialRow[]> {
  let userCredNames: Set<string> | null = null;
  if (userId) {
    try {
      const { resolveUserCredentials } = await import("./permissions.js");
      userCredNames = await resolveUserCredentials(userId);
    } catch (e: any) {
      logger.warn("resolveSandboxCredentialRows: credential resolution failed", {
        userId,
        error: e.message,
      });
      return [];
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

    const baseSelection = {
      id: credentials.id,
      name: credentials.name,
      ownerId: credentials.ownerId,
      scope: credentials.scope,
      sandboxEnvName: credentials.sandboxEnvName,
    };
    const rows = includeValue
      ? await db
          .select({
            ...baseSelection,
            value: credentials.value,
          })
          .from(credentials)
      : await db.select(baseSelection).from(credentials);

    const accessibleRows: SandboxCredentialRow[] = [];
    for (const row of rows) {
      // Gate 1: user must have access to this credential name
      if (userCredNames && !userCredNames.has(row.name)) continue;

      // Gate 2: for row-scoped credentials, only inject the calling user's
      // own row OR rows they've been explicitly granted access to.
      // Without this, two users with the same credential name (e.g.
      // `github_token`) would collide and the last row wins silently.
      // When userId is omitted, skip ALL row-scoped credentials to prevent
      // leaking every user's secrets into an anonymous sandbox.
      const scope = row.scope || "member";
      if (scope === "owner") {
        if (!userId) continue;
        if (row.ownerId !== userId && !grantedCredentialIds.has(row.id)) continue;
      } else if (scope === "per_user") {
        if (!userId) continue;
        if (row.ownerId !== userId && !grantedCredentialIds.has(row.id)) continue;
      } else if (
        scope !== "member" &&
        scope !== "power_user" &&
        scope !== "admin"
      ) {
        logger.warn("getSandboxEnvs: unknown credential scope", {
          userId,
          credentialName: row.name,
          scope,
        });
        continue;
      }

      accessibleRows.push(row);
    }

    return accessibleRows;
  } catch (e: any) {
    logger.warn("Failed to query credentials for sandbox injection", { error: e.message });
    return [];
  }
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
  const envOwnedByCaller = new Set<string>();
  const rows = await resolveSandboxCredentialRows(userId, true);

  for (const row of rows) {
    // Use the explicit sandboxEnvName if set, otherwise uppercase the name
    const envName = resolveSandboxEnvName(row);
    const ownedByCaller = !!userId && row.ownerId === userId;
    // Caller-owned credentials always win name/env-name collisions, even if
    // another accessible row with the same env var is processed later.
    if (envs[envName] !== undefined && envOwnedByCaller.has(envName) && !ownedByCaller) {
      continue;
    }
    try {
      envs[envName] = decryptCredential(row.value);
      if (ownedByCaller) {
        envOwnedByCaller.add(envName);
      }
    } catch (e: any) {
      logger.warn("Failed to decrypt credential for sandbox injection", {
        name: row.name,
        envName,
        error: e.message,
      });
    }
  }

  if (envs.GITHUB_TOKEN && !envs.GH_TOKEN) {
    envs.GH_TOKEN = envs.GITHUB_TOKEN;
  }

  // Scoped job execution: when the current execution context carries an env
  // allowlist, intersect the caller-scoped set with it. Applied here so every
  // sandbox path (tools, bootstrap, file writes) is covered uniformly.
  const allowlist = getActiveEnvAllowlist();
  if (allowlist != null) {
    const filtered = filterEnvsByAllowlist(envs, allowlist);
    logger.info("getSandboxEnvs: env allowlist applied", {
      userId,
      allowlistSize: allowlist.length,
      before: Object.keys(envs).length,
      after: Object.keys(filtered).length,
    });
    return filtered;
  }

  return envs;
}

/** Ownership/provenance metadata for one sandbox env var. Never carries values. */
export interface SandboxEnvVarInfo {
  envName: string;
  /** Credential scope: owner | per_user | member | power_user | admin */
  scope: string;
  /**
   * Display name of the credential's owner. Resolved only for caller-scoped
   * rows (owner/per_user) -- null for role-tier/shared rows and when the
   * owner has no users row.
   */
  ownerDisplayName: string | null;
}

const CALLER_SCOPED_SCOPES = new Set(["owner", "per_user"]);

/**
 * Return the sandbox env vars available to the user, with ownership metadata.
 *
 * Mirrors getSandboxEnvs() access control and collision handling (caller-owned
 * rows win env name collisions) without selecting, decrypting, or returning
 * credential values. Used to make the LLM aware of available sandbox
 * capabilities -- and, for caller-scoped credentials, WHOSE credential the env
 * var resolves from -- without exposing secrets.
 */
export async function getSandboxEnvNames(
  userId?: string,
): Promise<SandboxEnvVarInfo[]> {
  const rows = await resolveSandboxCredentialRows(userId, false);

  // Mirror getSandboxEnvs(): caller-owned credentials always win env name
  // collisions; otherwise the last processed row wins.
  const byEnvName = new Map<string, SandboxCredentialRow>();
  const envOwnedByCaller = new Set<string>();
  for (const row of rows) {
    const envName = resolveSandboxEnvName(row);
    const ownedByCaller = !!userId && row.ownerId === userId;
    if (byEnvName.has(envName) && envOwnedByCaller.has(envName) && !ownedByCaller) {
      continue;
    }
    byEnvName.set(envName, row);
    if (ownedByCaller) envOwnedByCaller.add(envName);
  }

  // Resolve owner display names for caller-scoped rows only -- provenance for
  // attribution. Shared/role-tier rows render as bare names downstream.
  const ownerIds = [
    ...new Set(
      [...byEnvName.values()]
        .filter((row) => CALLER_SCOPED_SCOPES.has(row.scope || "member"))
        .map((row) => row.ownerId),
    ),
  ];
  const displayNames = new Map<string, string>();
  if (ownerIds.length > 0) {
    try {
      const { inArray } = await import("drizzle-orm");
      const ownerRows = await db
        .select({
          slackUserId: users.slackUserId,
          displayName: users.displayName,
        })
        .from(users)
        .where(inArray(users.slackUserId, ownerIds));
      for (const owner of ownerRows) {
        if (owner.slackUserId) displayNames.set(owner.slackUserId, owner.displayName);
      }
    } catch (e: any) {
      logger.warn("getSandboxEnvNames: owner display name lookup failed", {
        error: e.message,
      });
    }
  }

  return [...byEnvName.entries()]
    .map(([envName, row]) => {
      const scope = row.scope || "member";
      return {
        envName,
        scope,
        ownerDisplayName: CALLER_SCOPED_SCOPES.has(scope)
          ? displayNames.get(row.ownerId) ?? null
          : null,
      };
    })
    .sort((a, b) => a.envName.localeCompare(b.envName));
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
    const mountCheck = await runTolerant(
      sandbox,
      "mountpoint -q /mnt/aura-files && echo mounted || echo not",
      { timeoutMs: 5_000, envs },
    );
    if (mountCheck.stdout?.trim() === "mounted") return;

    if (!envs.GOOGLE_SA_KEY_B64) {
      logger.info("Skipping GCS mount — GOOGLE_SA_KEY_B64 not available");
      return;
    }

    const gcsfuseCheck = await runTolerant(sandbox, "which gcsfuse", {
      timeoutMs: 5_000,
    });
    if (gcsfuseCheck.exitCode !== 0) {
      const distro = "bookworm";
      const installResult = await runTolerant(
        sandbox,
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

    const mountResult = await runTolerant(
      sandbox,
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
 * Ensure the self-authored tools repository is cloned, up to date, and has
 * its Python dependencies installed at /home/user/aura-tools (issue #960).
 *
 * Defaults to `realadvisor/aura-tools`; a workspace can point elsewhere via
 * the `tools_repo` setting. Idempotent and cheap by design:
 *   - once per process per sandbox id via the `auraToolsReady` session cache;
 *   - across processes via a marker file — when it is younger than
 *     AURA_TOOLS_FRESH_MINUTES the bootstrap is a single local probe with no
 *     git network round-trip;
 *   - Python deps are (re)installed only when the checkout actually changed.
 *
 * Non-fatal by design: a bad repo setting or a clone/pull/pip failure must
 * not make the sandbox unusable.
 */
export async function ensureAuraTools(
  sandbox: SandboxCommandRunner & { sandboxId?: string },
  envs: Record<string, string>,
): Promise<void> {
  const sessionKey = sandbox.sandboxId ?? "unknown-sandbox";
  if (auraToolsReady.has(sessionKey)) return;

  let toolsRepo = AURA_TOOLS_DEFAULT_REPO;
  const rawToolsRepo = (await getSetting(TOOLS_REPO_SETTING_KEY))?.trim();
  if (rawToolsRepo) {
    const normalized = normalizeToolsRepo(rawToolsRepo);
    if (normalized) {
      toolsRepo = normalized;
    } else {
      logger.warn(
        "Invalid tools_repo setting; expected a GitHub owner/name or HTTPS URL — falling back to the default tools repository",
        { value: rawToolsRepo, defaultRepo: AURA_TOOLS_DEFAULT_REPO },
      );
    }
  }

  const commandEnvs = { ...envs };
  if (!commandEnvs.GITHUB_TOKEN && commandEnvs.GH_TOKEN) {
    commandEnvs.GITHUB_TOKEN = commandEnvs.GH_TOKEN;
  }

  if (!commandEnvs.GITHUB_TOKEN) {
    recordError(
      "sandbox.ensureAuraTools",
      new Error("Skipping tools repo clone because GITHUB_TOKEN is not available"),
      { toolsRepo },
    );
    return;
  }

  const checkoutPath = TOOLS_REPO_CHECKOUT_PATH;
  const checkoutPathArg = quoteShellArg(checkoutPath);
  const markerArg = quoteShellArg(AURA_TOOLS_SYNC_MARKER_PATH);
  const requirementsArg = quoteShellArg(`${checkoutPath}/requirements.txt`);

  try {
    // Single cheap probe: fresh marker → done; valid checkout → pull; else
    // clone. Shell-level guards keep the probe exiting 0 regardless of state —
    // the E2B SDK throws on non-zero exits, which previously made the
    // `git clone` below unreachable exactly when the checkout was missing
    // (issue #1363). Branch on stdout, never on the exit code.
    const probe = await runTolerant(
      sandbox,
      `if [ -f ${markerArg} ] && [ -n "$(find ${markerArg} -mmin -${AURA_TOOLS_FRESH_MINUTES} 2>/dev/null)" ]; then echo AURA_TOOLS_FRESH; elif git -C ${checkoutPathArg} rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo AURA_TOOLS_PRESENT; else echo AURA_TOOLS_MISSING; fi`,
      { timeoutMs: 5_000, envs: commandEnvs },
    );

    if (probe.stdout.includes("AURA_TOOLS_FRESH")) {
      auraToolsReady.add(sessionKey);
      return;
    }

    let checkoutChanged: boolean;
    if (probe.stdout.includes("AURA_TOOLS_PRESENT")) {
      const pullResult = await runTolerant(
        sandbox,
        `git -C ${checkoutPathArg} pull --ff-only`,
        { timeoutMs: 60_000, envs: commandEnvs },
      );
      if (pullResult.exitCode !== 0) {
        // Keep the existing (stale but usable) checkout; do NOT touch the
        // marker so the next acquisition retries the refresh.
        logger.warn("Failed to refresh tools repository", {
          toolsRepo,
          checkoutPath,
          exitCode: pullResult.exitCode,
          stderr: redactGitAuth(pullResult.stderr),
        });
        return;
      }
      checkoutChanged = !pullResult.stdout.includes("Already up to date");
    } else {
      const cloneResult = await runTolerant(
        sandbox,
        `git clone --depth=1 "https://x-access-token:$GITHUB_TOKEN@github.com/${toolsRepo}.git" ${checkoutPathArg}`,
        { timeoutMs: 120_000, envs: commandEnvs },
      );
      if (cloneResult.exitCode !== 0) {
        recordError(
          "sandbox.ensureAuraTools",
          new Error("Failed to clone tools repository"),
          {
            toolsRepo,
            checkoutPath,
            exitCode: cloneResult.exitCode,
            stderr: redactGitAuth(cloneResult.stderr),
          },
        );
        return;
      }
      checkoutChanged = true;
    }

    // Install Python deps only when the checkout changed; pip failures are
    // logged but don't block the marker — the repo itself is fresh and the
    // failure will surface (with logs) on the next tool run.
    const finalizeCommand = checkoutChanged
      ? `if [ -f ${requirementsArg} ]; then python3 -m pip install --quiet --disable-pip-version-check -r ${requirementsArg} || echo AURA_TOOLS_DEPS_FAILED; fi; touch ${markerArg}`
      : `touch ${markerArg}`;
    const finalizeResult = await runTolerant(sandbox, finalizeCommand, {
      timeoutMs: 300_000,
      envs: commandEnvs,
    });
    if (finalizeResult.stdout.includes("AURA_TOOLS_DEPS_FAILED")) {
      logger.warn("Tools repository Python dependency install failed", {
        toolsRepo,
        checkoutPath,
        stderr: finalizeResult.stderr,
      });
    }

    auraToolsReady.add(sessionKey);
  } catch (error: any) {
    recordError("sandbox.ensureAuraTools", error, { toolsRepo, checkoutPath });
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
    const mountCheck = await runTolerant(
      sandbox,
      "mountpoint -q /mnt/aura-files && echo mounted || echo not",
      { timeoutMs: 5_000, envs },
    );
    if (mountCheck.stdout?.trim() !== "mounted") {
      logger.info("GCS not mounted, falling back to /home/user", { userId });
      return fallback;
    }

    const userHome = `/mnt/aura-files/users/${userId}`;

    const mkdirResult = await runTolerant(
      sandbox,
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
export async function getOrCreateSandbox(userId?: string): Promise<any> {
  // Return cached instance within the same invocation IF it's for the same user.
  // Per-invocation caches must not be shared across users -- a warm Vercel instance
  // serving two different users back-to-back must hit fresh per-user sandboxes.
  if (cachedSandbox && cachedSandboxUserId === userId) {
    try {
      // Reset timeout to keep it alive
      await cachedSandbox.setTimeout(DEFAULT_TIMEOUT_MS);
      return cachedSandbox;
    } catch {
      cachedSandbox = null;
      cachedSandboxUserId = undefined;
      userHomeReady.clear();
    }
  } else if (cachedSandbox && cachedSandboxUserId !== userId) {
    // Different user this invocation -- drop the cache reference (don't kill the sandbox,
    // it stays running/paused under its own ID for that other user).
    cachedSandbox = null;
    cachedSandboxUserId = undefined;
    userHomeReady.clear();
  }

  const Sandbox = await loadE2B();
  // Resolve envs for the calling user so owner-scoped credentials (e.g. GITHUB_TOKEN)
  // are available to ensureAuraTools; fall back to "aura" when no user is known.
  const envs = await getSandboxEnvs(userId ?? "aura");

  const apiKey = envs.E2B_API_KEY;
  if (!apiKey) {
    throw new Error(
      "E2B_API_KEY is not configured. Add it as a credential in the dashboard.",
    );
  }

  // Try to resume a previously paused sandbox (per-user key).
  const noteKey = sandboxNoteKey(userId);
  const templateKey = sandboxTemplateKey(userId);
  let savedId = await getSetting(noteKey);
  const savedTemplateId = await getSetting(templateKey);
  const currentTemplateId = envs.E2B_TEMPLATE_ID || process.env.E2B_TEMPLATE_ID || undefined;

  // If the template was upgraded, kill the old sandbox so we create a fresh one
  if (savedId && currentTemplateId && savedTemplateId !== currentTemplateId) {
    logger.info("Template mismatch, killing old sandbox", {
      savedId,
      savedTemplateId: savedTemplateId || "unknown",
      currentTemplateId,
    });
    try {
      await Sandbox.kill(savedId, { apiKey });
    } catch (e: any) {
      logger.warn("Failed to kill old sandbox (best-effort)", { error: e.message });
    }
    savedId = null;
  }

  if (savedId) {
    try {
      logger.info("Resuming E2B sandbox", { sandboxId: savedId });
      const sandbox = await Sandbox.connect(savedId, {
        apiKey,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      // Health check: verify the sandbox is actually responsive
      const healthCheck = await runTolerant(sandbox, "echo ok", {
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
        error: error.message,
      });
    }

    if (cachedSandbox) {
      const diskOk = await ensureSandboxDiskSpace(cachedSandbox, envs);
      if (diskOk) {
        await setupSandboxFilesystem(cachedSandbox, envs);
        await ensureAuraTools(cachedSandbox, envs);
        return cachedSandbox;
      }

      // Disk is still critically full after reclaiming regenerable space, so the
      // resumed sandbox is effectively unusable (commands fail at launch with
      // "No space left on device"). Discard it and fall through to create a fresh one.
      logger.warn("Resumed sandbox disk unrecoverable, recreating from scratch", {
        savedId,
      });
      try {
        await Sandbox.kill(savedId, { apiKey });
      } catch (e: any) {
        logger.warn("Failed to kill disk-full sandbox (best-effort)", { error: e.message });
      }
      cachedSandbox = null;
      cachedSandboxUserId = undefined;
      userHomeReady.clear();
      savedId = null;
    }
  }

  // Create a new sandbox
  const templateId = envs.E2B_TEMPLATE_ID || process.env.E2B_TEMPLATE_ID || undefined;
  logger.info("Creating new E2B sandbox", { templateId: templateId || "default" });

  // autoPause: E2B pauses the sandbox after DEFAULT_TIMEOUT_MS of inactivity
  // and Sandbox.connect() will auto-resume it on the next call. This removes
  // our need to manually pauseSandbox() (which triggered E2B bug #884 -- file
  // state loss after 2+ pause/resume cycles on the legacy betaPause path).
  const createOptions: any = { apiKey, timeoutMs: DEFAULT_TIMEOUT_MS, autoPause: true };
  const sandbox = templateId
    ? await Sandbox.create(templateId, createOptions)
    : await Sandbox.create(createOptions);

  // Save the sandbox ID for future resumption (per-user keys)
  await setSetting(noteKey, sandbox.sandboxId, "aura");
  await setSetting(templateKey, templateId || "", "aura");

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
    const check = await runTolerant(sandbox, "which claude", {
      timeoutMs: 5_000,
      envs,
    });
    if (check.exitCode !== 0) {
      logger.info("Installing Claude Code in sandbox");
      const installResult = await runTolerant(
        sandbox,
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
  await ensureAuraTools(sandbox, envs);

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
  userId?: string,
): Promise<string> {
  const sandbox = await getOrCreateSandbox(userId);

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

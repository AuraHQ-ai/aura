import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  getOrCreateSandbox,
  getSandboxEnvs,
  truncateOutput,
  ensureUserHome,
} from "../lib/sandbox.js";
import { logger } from "../lib/logger.js";
import { defineTool } from "../lib/tool.js";
import { detachedCommands, type DetachedCommand, type ScheduleContext } from "@aura/db/schema";
import { eq } from "drizzle-orm";

const BACKGROUND_COMMAND_DIR = "/tmp/aura-bg";
const CALLBACK_TAIL_BYTES = 16 * 1024;
const DEFAULT_PUBLIC_URL = "https://aura-alpha-five.vercel.app";

type Sandbox = Awaited<ReturnType<typeof getOrCreateSandbox>>;
type CommandEnv = Record<string, string>;

interface DetachedCommandStart {
  id: string;
  pid: number;
  started_at: string;
}

interface DetachedCommandStatus {
  status: "running" | "exited" | "not_found";
  exit_code?: number;
  stdout_tail: string;
  stderr_tail: string;
  runtime_s: number;
}

type DetachedCommandDbStatus = "running" | "completed" | "failed" | "killed";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function backgroundPath(id: string, suffix: "out" | "err" | "pid" | "status" | "started_at") {
  return `${BACKGROUND_COMMAND_DIR}/${id}.${suffix}`;
}

function getPublicUrl(): string {
  if (process.env.AURA_PUBLIC_URL) {
    return process.env.AURA_PUBLIC_URL.replace(/\/+$/, "");
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`.replace(/\/+$/, "");
  }
  return DEFAULT_PUBLIC_URL;
}

function getWorkspaceId(context?: ScheduleContext): string {
  return context?.workspaceId || process.env.DEFAULT_WORKSPACE_ID || "default";
}

function tailLines(value: string | null | undefined, lines: number): string {
  if (!value) return "";
  const split = value.split("\n");
  return split.length <= lines ? value : split.slice(-lines).join("\n");
}

function getRuntimeSeconds(startedAt: Date, completedAt?: Date | null): number {
  const end = completedAt?.getTime() ?? Date.now();
  return Math.max(0, Math.floor((end - startedAt.getTime()) / 1000));
}

function mapDbStatus(status: string): "running" | "exited" | "not_found" {
  if (status === "running") return "running";
  if (status === "completed" || status === "failed" || status === "killed") return "exited";
  return "not_found";
}

function statusFromExitCode(exitCode: number | undefined): DetachedCommandDbStatus {
  return exitCode === 0 ? "completed" : "failed";
}

async function getDb() {
  const { db } = await import("../db/client.js");
  return db;
}

async function insertDetachedCommandRow(input: {
  id: string;
  pid: number;
  command: string;
  context?: ScheduleContext;
  userId: string;
}) {
  const db = await getDb();
  await db
    .insert(detachedCommands)
    .values({
      id: input.id,
      pid: input.pid,
      command: input.command,
      status: "running",
      requestedBy: input.context?.userId || input.userId,
      channelId: input.context?.channelId || null,
      threadTs: input.context?.threadTs || null,
      workspaceId: getWorkspaceId(input.context),
    })
    .onConflictDoUpdate({
      target: detachedCommands.id,
      set: {
        pid: input.pid,
        command: input.command,
        status: "running",
        exitCode: null,
        requestedBy: input.context?.userId || input.userId,
        channelId: input.context?.channelId || null,
        threadTs: input.context?.threadTs || null,
        workspaceId: getWorkspaceId(input.context),
        startedAt: new Date(),
        completedAt: null,
        stdoutTail: null,
        stderrTail: null,
      },
    });
}

async function getDetachedCommandRow(id: string): Promise<DetachedCommand | undefined> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(detachedCommands)
    .where(eq(detachedCommands.id, id))
    .limit(1);
  return rows[0];
}

async function updateDetachedCommandRowFromStatus(
  id: string,
  status: DetachedCommandDbStatus,
  snapshot: DetachedCommandStatus,
): Promise<void> {
  const db = await getDb();
  await db
    .update(detachedCommands)
    .set({
      status,
      exitCode: snapshot.exit_code ?? null,
      completedAt: new Date(),
      stdoutTail: truncateOutput(snapshot.stdout_tail || "", CALLBACK_TAIL_BYTES),
      stderrTail: truncateOutput(snapshot.stderr_tail || "", CALLBACK_TAIL_BYTES),
    })
    .where(eq(detachedCommands.id, id));
}

function statusFromDbRow(row: DetachedCommand, tailLineCount: number): DetachedCommandStatus {
  return {
    status: mapDbStatus(row.status),
    exit_code: row.exitCode ?? undefined,
    stdout_tail: tailLines(row.stdoutTail, tailLineCount),
    stderr_tail: tailLines(row.stderrTail, tailLineCount),
    runtime_s: getRuntimeSeconds(row.startedAt, row.completedAt),
  };
}

export function buildDetachedScript(id: string, command: string, startedAtEpoch: number): string {
  const stdoutPath = backgroundPath(id, "out");
  const stderrPath = backgroundPath(id, "err");
  const pidPath = backgroundPath(id, "pid");
  const statusPath = backgroundPath(id, "status");
  const startedAtPath = backgroundPath(id, "started_at");
  const payloadPath = `${BACKGROUND_COMMAND_DIR}/${id}.callback.json`;
  const signaturePath = `${BACKGROUND_COMMAND_DIR}/${id}.callback.sig`;
  const callbackUrl = `${getPublicUrl()}/api/webhook/sandbox-command`;

  return [
    `mkdir -p ${shellQuote(BACKGROUND_COMMAND_DIR)}`,
    `rm -f ${shellQuote(stdoutPath)} ${shellQuote(stderrPath)} ${shellQuote(pidPath)} ${shellQuote(statusPath)} ${shellQuote(startedAtPath)} ${shellQuote(payloadPath)} ${shellQuote(signaturePath)}`,
    `printf '%s\\n' ${shellQuote(String(startedAtEpoch))} > ${shellQuote(startedAtPath)}`,
    `nohup bash -c ${shellQuote(command)} > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)} &`,
    "pid=$!",
    `printf '%s\\n' "$pid" > ${shellQuote(pidPath)}`,
    "wait \"$pid\"",
    "exit_code=$?",
    `printf '%s\\n' "$exit_code" > ${shellQuote(statusPath)}`,
    `if [ -n "\${AURA_PUBLIC_URL:-}" ] && [ -n "\${SANDBOX_WEBHOOK_SECRET:-}" ]; then`,
    `  AURA_COMMAND_ID=${shellQuote(id)} AURA_EXIT_CODE="$exit_code" AURA_STDOUT_PATH=${shellQuote(stdoutPath)} AURA_STDERR_PATH=${shellQuote(stderrPath)} AURA_PAYLOAD_PATH=${shellQuote(payloadPath)} AURA_SIGNATURE_PATH=${shellQuote(signaturePath)} python3 - <<'PY'`,
    "import hashlib",
    "import hmac",
    "import json",
    "import os",
    "",
    `tail_bytes = ${CALLBACK_TAIL_BYTES}`,
    "",
    "def read_tail(path):",
    "    try:",
    "        with open(path, 'rb') as file:",
    "            file.seek(0, os.SEEK_END)",
    "            size = file.tell()",
    "            file.seek(max(0, size - tail_bytes), os.SEEK_SET)",
    "            return file.read().decode('utf-8', errors='replace')",
    "    except OSError:",
    "        return ''",
    "",
    "payload = {",
    "    'id': os.environ['AURA_COMMAND_ID'],",
    "    'exit_code': int(os.environ['AURA_EXIT_CODE']),",
    "    'stdout_tail': read_tail(os.environ['AURA_STDOUT_PATH']),",
    "    'stderr_tail': read_tail(os.environ['AURA_STDERR_PATH']),",
    "}",
    "raw = json.dumps(payload, separators=(',', ':')).encode('utf-8')",
    "signature = 'sha256=' + hmac.new(",
    "    os.environ['SANDBOX_WEBHOOK_SECRET'].encode('utf-8'),",
    "    raw,",
    "    hashlib.sha256,",
    ").hexdigest()",
    "with open(os.environ['AURA_PAYLOAD_PATH'], 'wb') as file:",
    "    file.write(raw)",
    "with open(os.environ['AURA_SIGNATURE_PATH'], 'w', encoding='utf-8') as file:",
    "    file.write(signature)",
    "PY",
    `  curl -sS --max-time 30 --retry 3 --retry-delay 5 -X POST ${shellQuote(callbackUrl)} -H 'Content-Type: application/json' -H "x-webhook-signature: $(cat ${shellQuote(signaturePath)})" --data-binary @${shellQuote(payloadPath)} >/dev/null || true`,
    "fi",
  ].join("\n");
}

async function readDetachedPid(sandbox: Sandbox, id: string, envs: CommandEnv): Promise<number> {
  const pidPath = backgroundPath(id, "pid");
  const readPidCommand = `if [ -s ${shellQuote(pidPath)} ]; then cat ${shellQuote(pidPath)}; else exit 1; fi`;

  for (const delayMs of [0, 50, 100, 200, 400, 800]) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    try {
      const result = await sandbox.commands.run(readPidCommand, {
        timeoutMs: 500,
        envs,
      });
      const pid = Number.parseInt((result.stdout || "").trim(), 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    } catch {
      // The background wrapper may need a short moment to write the pid file.
    }
  }

  throw new Error(`Detached command ${id} did not write a pid file`);
}

async function startDetachedCommand(options: {
  sandbox: Sandbox;
  command: string;
  cwd: string;
  envs: CommandEnv;
}): Promise<DetachedCommandStart> {
  const id = randomUUID().slice(0, 8);
  const startedAtEpoch = Math.floor(Date.now() / 1000);
  const started_at = new Date(startedAtEpoch * 1000).toISOString();

  await options.sandbox.commands.run(buildDetachedScript(id, options.command, startedAtEpoch), {
    cwd: options.cwd,
    background: true,
    envs: options.envs,
  });

  const pid = await readDetachedPid(options.sandbox, id, options.envs);

  return { id, pid, started_at };
}

async function waitForDetachedCommand(options: {
  sandbox: Sandbox;
  id: string;
  pid: number;
  timeoutSeconds: number;
  envs: CommandEnv;
}): Promise<"exited" | "not_running" | "timeout"> {
  const waitScript = `python3 - <<'PY'
import os
import sys
import time

command_id = os.environ["AURA_COMMAND_ID"]
pid = int(os.environ["AURA_COMMAND_PID"])
timeout_s = float(os.environ["AURA_INLINE_TIMEOUT_SECONDS"])
status_path = f"${BACKGROUND_COMMAND_DIR}/{command_id}.status"
deadline = time.monotonic() + timeout_s

while time.monotonic() < deadline:
    if os.path.exists(status_path):
        print("exited")
        sys.exit(0)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        print("not_running")
        sys.exit(0)
    except PermissionError:
        pass
    time.sleep(0.5)

print("timeout")
PY`;

  const result = await options.sandbox.commands.run(waitScript, {
    timeoutMs: options.timeoutSeconds * 1000 + 2_000,
    envs: {
      ...options.envs,
      AURA_COMMAND_ID: options.id,
      AURA_COMMAND_PID: String(options.pid),
      AURA_INLINE_TIMEOUT_SECONDS: String(options.timeoutSeconds),
    },
  });

  const status = (result.stdout || "").trim();
  if (status === "exited" || status === "not_running" || status === "timeout") {
    return status;
  }
  return "timeout";
}

async function inspectDetachedCommand(
  sandbox: Sandbox,
  id: string,
  tailLines: number,
  envs: CommandEnv,
): Promise<DetachedCommandStatus> {
  const inspectScript = `python3 - <<'PY'
import json
import os
import subprocess
import time

command_id = os.environ["AURA_COMMAND_ID"]
tail_lines = max(1, min(int(os.environ.get("AURA_TAIL_LINES", "200")), 1000))
base = f"${BACKGROUND_COMMAND_DIR}/{command_id}"
pid_path = f"{base}.pid"
status_path = f"{base}.status"
started_at_path = f"{base}.started_at"

def read_int(path):
    try:
        with open(path, "r", encoding="utf-8") as file:
            return int(file.read().strip())
    except (OSError, ValueError):
        return None

def tail(path):
    try:
        completed = subprocess.run(
            ["tail", "-n", str(tail_lines), path],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=0.75,
            check=False,
        )
        return completed.stdout
    except Exception:
        return ""

pid = read_int(pid_path)
exit_code = read_int(status_path)

if exit_code is not None:
    status = "exited"
elif pid is not None:
    try:
        os.kill(pid, 0)
        status = "running"
    except ProcessLookupError:
        status = "exited"
    except PermissionError:
        status = "running"
else:
    status = "not_found"

started_at = read_int(started_at_path)
if started_at is None:
    try:
        started_at = int(os.stat(pid_path).st_mtime)
    except OSError:
        started_at = int(time.time())

payload = {
    "status": status,
    "stdout_tail": tail(f"{base}.out"),
    "stderr_tail": tail(f"{base}.err"),
    "runtime_s": max(0, int(time.time()) - started_at),
}
if exit_code is not None:
    payload["exit_code"] = exit_code

print(json.dumps(payload))
PY`;

  const result = await sandbox.commands.run(inspectScript, {
    timeoutMs: 2_000,
    envs: {
      ...envs,
      AURA_COMMAND_ID: id,
      AURA_TAIL_LINES: String(tailLines),
    },
  });

  const parsed = JSON.parse((result.stdout || "{}").trim()) as Partial<DetachedCommandStatus>;
  return {
    status: parsed.status === "running" || parsed.status === "exited" || parsed.status === "not_found"
      ? parsed.status
      : "not_found",
    exit_code: typeof parsed.exit_code === "number" ? parsed.exit_code : undefined,
    stdout_tail: typeof parsed.stdout_tail === "string" ? parsed.stdout_tail : "",
    stderr_tail: typeof parsed.stderr_tail === "string" ? parsed.stderr_tail : "",
    runtime_s: typeof parsed.runtime_s === "number" ? parsed.runtime_s : 0,
  };
}

async function readDetachedOutputs(
  sandbox: Sandbox,
  id: string,
  envs: CommandEnv,
): Promise<{ stdout: string; stderr: string }> {
  const outputScript = `python3 - <<'PY'
import json
import os

command_id = os.environ["AURA_COMMAND_ID"]
base = f"${BACKGROUND_COMMAND_DIR}/{command_id}"

def read_snippet(path, max_bytes):
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as file:
            if size <= max_bytes:
                data = file.read()
            else:
                half = max_bytes // 2
                start = file.read(half)
                file.seek(-half, os.SEEK_END)
                end = file.read(half)
                marker = f"\\n\\n...(truncated {size - max_bytes} chars)...\\n\\n".encode("utf-8")
                data = start + marker + end
        return data.decode("utf-8", errors="replace")
    except OSError:
        return ""

print(json.dumps({
    "stdout": read_snippet(f"{base}.out", 4000),
    "stderr": read_snippet(f"{base}.err", 2000),
}))
PY`;

  const result = await sandbox.commands.run(outputScript, {
    timeoutMs: 5_000,
    envs: {
      ...envs,
      AURA_COMMAND_ID: id,
    },
  });
  const parsed = JSON.parse((result.stdout || "{}").trim()) as { stdout?: unknown; stderr?: unknown };
  return {
    stdout: typeof parsed.stdout === "string" ? truncateOutput(parsed.stdout, 4000) : "",
    stderr: typeof parsed.stderr === "string" ? truncateOutput(parsed.stderr, 2000) : "",
  };
}

/**
 * Create sandbox tools for the AI SDK.
 * Provides shell execution in an E2B cloud sandbox.
 * run_command is the universal primitive -- use cat/head/tail for reading files,
 * heredocs for writing, git/rg/grep for search, etc.
 */
export function createSandboxTools(context?: ScheduleContext) {
  return {
    run_command: defineTool({
      description:
        "Execute a shell command in a sandboxed Linux VM and wait inline for short synchronous work. Use this for commands expected to finish within about 120s: file ops, git, code execution (node, python), search (rg, grep), data processing (curl, jq), and quick self-modification via Claude Code (claude). For long-running or uncertain work, call run_command_detached first and poll with check_command. If this command exceeds its inline timeout while the process keeps running, it returns a command id and PID so you can call check_command({ id }) instead of losing progress. Pre-installed: git, node, python, gh, gcloud, vercel CLI, ripgrep, curl, jq, claude. Install more with apt-get or pip. The sandbox persists between conversations -- files and state are preserved across messages. Output is truncated; use head, tail, grep to filter. Break complex tasks into smaller commands. Default timeout is 90s; explicitly opt in to longer timeouts only for headless/batch work or long-running agent commands. Slack chat.stream sessions cap around 3 minutes, so individual tool calls longer than 90s risk freezing the in-flight Slack stream before the final result arrives. If you run for/while loops with outbound network calls, start the script with set -e so one failure or timeout aborts the loop instead of compounding many slow failures. For complex workflows, check your skill notes first. Hard max is 750s for headless jobs and agent commands like Claude Code, leaving a 50s buffer before the Vercel function timeout at 800s.",
      requiredCredentials: ["e2b_api_key"],
      inputSchema: z.object({
        command: z
          .string()
          .describe(
            "The shell command to run, e.g. 'git clone https://github.com/org/repo.git' or 'cat /home/user/output.txt'",
          ),
        workdir: z
          .string()
          .optional()
          .describe(
            "Working directory for the command, e.g. '/home/user/repo'. Defaults to /home/user.",
          ),
        timeout_seconds: z
          .number()
          .min(1)
          .max(750)
          .default(90)
          .describe(
            "Command timeout in seconds (default 90, max 750). Explicitly opt in to values above 90s only for headless/batch work or long-running agent commands; Slack chat.stream caps around 3 minutes, so longer foreground calls can freeze the active Slack message.",
          ),
      }),
      execute: async ({ command, workdir, timeout_seconds }) => {
        const userId = context?.userId || "aura";
        try {
          const sandbox = await getOrCreateSandbox(userId);
          const envs = await getSandboxEnvs(userId);
          const userHome = await ensureUserHome(sandbox, userId, envs);
          const commandEnv = {
            ...envs,
            USER_HOME: userHome,
            PERSISTENT_HOME: userHome,
            SLACK_USER_ID: userId,
            AURA_PUBLIC_URL: getPublicUrl(),
            SANDBOX_WEBHOOK_SECRET: process.env.SANDBOX_WEBHOOK_SECRET || "",
          };

          logger.info("run_command tool: executing", {
            command: command.substring(0, 100),
            workdir,
          });

          const detached = await startDetachedCommand({
            sandbox,
            command,
            cwd: workdir || userHome,
            envs: commandEnv,
          });

          await waitForDetachedCommand({
            sandbox,
            id: detached.id,
            pid: detached.pid,
            timeoutSeconds: timeout_seconds,
            envs: commandEnv,
          });

          const status = await inspectDetachedCommand(sandbox, detached.id, 200, commandEnv);

          if (status.status === "running") {
            logger.info("run_command tool: inline timeout while still running", {
              command: command.substring(0, 100),
              id: detached.id,
              pid: detached.pid,
              timeoutSeconds: timeout_seconds,
            });

            return {
              ok: false,
              error: `Command exceeded inline timeout (${timeout_seconds}s) but is still running as PID ${detached.pid}. Call check_command({id: '${detached.id}'}) to poll progress, or run 'kill ${detached.pid}' to stop it.`,
              id: detached.id,
              pid: detached.pid,
            };
          }

          const outputs = await readDetachedOutputs(sandbox, detached.id, commandEnv);
          const stdout = truncateOutput(outputs.stdout || "", 4000);
          const stderr = truncateOutput(outputs.stderr || "", 2000);
          const exitCode = status.exit_code ?? 124;

          logger.info("run_command tool: completed", {
            command: command.substring(0, 100),
            id: detached.id,
            pid: detached.pid,
            exitCode,
            stdoutLength: (outputs.stdout || "").length,
            stderrLength: (outputs.stderr || "").length,
          });

          return {
            ok: true,
            exit_code: exitCode,
            stdout,
            stderr: stderr || undefined,
          };
        } catch (error: any) {
          logger.error("run_command tool failed", {
            command: command.substring(0, 100),
            error: error.message,
          });

          return {
            ok: false,
            error: `Command execution failed: ${error.message}`,
          };
        }
      },
      slack: {
        status: "Running a command in the sandbox...",
        detail: (input) =>
          !input.command ? undefined
            : input.command.length <= 120
              ? input.command
              : input.command.slice(0, 119) + "…",
        output: (result) => {
          if ("ok" in result && !result.ok) return result.error;
          if (!("exit_code" in result)) return undefined;
          const r = result as { exit_code: number; stdout?: string; stderr?: string };
          if (r.exit_code === 0) return undefined;
          const stderr = typeof r.stderr === "string" ? r.stderr.trim() : "";
          const stdout = typeof r.stdout === "string" ? r.stdout.trim() : "";
          const detail = stderr || stdout;
          if (detail) {
            const truncated = detail.length <= 180 ? detail : detail.slice(0, 179) + "…";
            return `Exit code ${r.exit_code}: ${truncated}`;
          }
          return `Exit code ${r.exit_code}`;
        },
      },
    }),
    run_command_detached: defineTool({
      description:
        "Start a long-running shell command in the sandbox and return immediately with { id, pid, started_at }. Use this instead of run_command when work may exceed about 120s, has uncertain duration, or should keep running while you continue the conversation. The command writes stdout/stderr/status under /tmp/aura-bg/<id>.*. Poll progress with check_command({ id }); stop it with run_command({ command: 'kill <pid>' }) if needed.",
      requiredCredentials: ["e2b_api_key"],
      inputSchema: z.object({
        command: z
          .string()
          .describe(
            "The shell command to start in the background, e.g. 'pnpm test' or 'sleep 300'.",
          ),
        workdir: z
          .string()
          .optional()
          .describe(
            "Working directory for the command, e.g. '/home/user/repo'. Defaults to /home/user.",
          ),
        env: z
          .record(z.string())
          .optional()
          .describe(
            "Additional environment variables for this command. Values are injected into the sandbox process and should not be echoed.",
          ),
      }),
      execute: async ({ command, workdir, env }) => {
        const userId = context?.userId || "aura";
        try {
          const sandbox = await getOrCreateSandbox(userId);
          const envs = await getSandboxEnvs(userId);
          const userHome = "/home/user";
          const commandEnv = {
            ...envs,
            ...(env ?? {}),
            USER_HOME: userHome,
            PERSISTENT_HOME: userHome,
            SLACK_USER_ID: userId,
            AURA_PUBLIC_URL: getPublicUrl(),
            SANDBOX_WEBHOOK_SECRET: process.env.SANDBOX_WEBHOOK_SECRET || "",
          };

          logger.info("run_command_detached tool: starting", {
            command: command.substring(0, 100),
            workdir,
          });

          const detached = await startDetachedCommand({
            sandbox,
            command,
            cwd: workdir || userHome,
            envs: commandEnv,
          });

          await insertDetachedCommandRow({
            id: detached.id,
            pid: detached.pid,
            command,
            context,
            userId,
          });

          logger.info("run_command_detached tool: started", {
            command: command.substring(0, 100),
            id: detached.id,
            pid: detached.pid,
          });

          return detached;
        } catch (error: any) {
          logger.error("run_command_detached tool failed", {
            command: command.substring(0, 100),
            error: error.message,
          });

          return {
            ok: false,
            error: `Command launch failed: ${error.message}`,
          };
        }
      },
      slack: {
        status: "Starting detached command...",
        detail: (input) =>
          !input.command ? undefined
            : input.command.length <= 120
              ? input.command
              : input.command.slice(0, 119) + "…",
        output: (result) => {
          if ("ok" in result && !result.ok) return result.error;
          if (!("id" in result) || !("pid" in result)) return undefined;
          return `Started ${result.id} as PID ${result.pid}`;
        },
      },
    }),
    check_command: defineTool({
      description:
        "Poll a command started by run_command_detached, or a run_command call that exceeded its inline timeout and returned an id. Use this to check long-running sandbox work without blocking Slack streaming. Returns status ('running', 'exited', or 'not_found'), exit_code when available, stdout_tail, stderr_tail, and runtime_s. Default tail is 200 lines; increase tail_lines only when you need more recent output.",
      requiredCredentials: ["e2b_api_key"],
      inputSchema: z.object({
        id: z
          .string()
          .regex(/^[a-f0-9]{8}$/)
          .describe("The 8-character command id returned by run_command_detached or a timed-out run_command."),
        tail_lines: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(200)
          .describe("Number of recent stdout/stderr lines to return from each stream. Defaults to 200."),
      }),
      execute: async ({ id, tail_lines }) => {
        const userId = context?.userId || "aura";
        try {
          let dbRow: DetachedCommand | undefined;
          try {
            dbRow = await getDetachedCommandRow(id);
            if (dbRow && dbRow.status !== "running") {
              return statusFromDbRow(dbRow, tail_lines);
            }
          } catch (dbError: any) {
            logger.warn("check_command: detached_commands lookup failed, falling back to sandbox files", {
              id,
              error: dbError.message,
            });
          }

          const sandbox = await getOrCreateSandbox(userId);
          const envs = await getSandboxEnvs(userId);
          const userHome = "/home/user";
          const commandEnv = {
            ...envs,
            USER_HOME: userHome,
            PERSISTENT_HOME: userHome,
            SLACK_USER_ID: userId,
            AURA_PUBLIC_URL: getPublicUrl(),
            SANDBOX_WEBHOOK_SECRET: process.env.SANDBOX_WEBHOOK_SECRET || "",
          };

          const fileStatus = await inspectDetachedCommand(sandbox, id, tail_lines, commandEnv);
          if (dbRow?.status === "running" && fileStatus.status === "exited") {
            try {
              await updateDetachedCommandRowFromStatus(
                id,
                fileStatus.exit_code === undefined ? "killed" : statusFromExitCode(fileStatus.exit_code),
                fileStatus,
              );
            } catch (dbError: any) {
              logger.warn("check_command: failed to persist terminal file status", {
                id,
                error: dbError.message,
              });
            }
          }

          return fileStatus;
        } catch (error: any) {
          logger.error("check_command tool failed", {
            id,
            error: error.message,
          });

          return {
            status: "not_found" as const,
            stdout_tail: "",
            stderr_tail: `Command check failed: ${error.message}`,
            runtime_s: 0,
          };
        }
      },
      slack: {
        status: "Checking command...",
        detail: (input) => input.id,
        output: (result) => {
          const exitCode = typeof result.exit_code === "number" ? ` (${result.exit_code})` : "";
          return `${result.status}${exitCode}, ${result.runtime_s}s`;
        },
      },
    }),
  };
}

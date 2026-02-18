import { tool } from "ai";
import { z } from "zod";
import {
  getOrCreateSandbox,
  getSandboxEnvs,
  truncateOutput,
  DEFAULT_TIMEOUT_MS,
} from "../lib/sandbox.js";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import type { ScheduleContext } from "../db/schema.js";

/**
 * Create sandbox tools for the AI SDK.
 * Provides shell execution in an E2B cloud sandbox.
 * run_command is the universal primitive — use cat/head/tail for reading files,
 * heredocs for writing, git/rg/grep for search, etc.
 */
export function createSandboxTools(
  context?: ScheduleContext,
  opts?: { onStreamOutput?: (text: string) => void; onActivity?: () => void },
) {
  return {
    run_command: tool({
      description:
        "Execute a shell command in a sandboxed Linux VM. The sandbox has git, node, python, gh (GitHub CLI), gcloud, vercel CLI, ripgrep, curl, jq, and Claude Code (claude) pre-installed. You can install additional tools with apt-get or pip. The sandbox persists between conversations -- files and state are preserved. Use cat/head/tail to read files, heredocs to write files, rg to search.",
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
          .max(780)
          .default(120)
          .describe("Command timeout in seconds (max 780). Use 600 for Claude Code tasks."),
      }),
      execute: async ({ command, workdir, timeout_seconds }) => {
        if (!isAdmin(context?.userId) && context?.userId !== "aura") {
          return {
            ok: false,
            error: "Only admins can run sandbox commands.",
          };
        }

        if (!process.env.E2B_API_KEY) {
          return {
            ok: false,
            error:
              "Sandbox execution is not available. E2B_API_KEY is not configured.",
          };
        }

        const onStreamOutput = opts?.onStreamOutput;
        let buf = "";
        let timer: ReturnType<typeof setTimeout> | null = null;
        let didStream = false;

        // Periodically signal activity so the caller's inactivity timer
        // doesn't fire during long-running commands that produce no output.
        const keepAlive = opts?.onActivity
          ? setInterval(() => { opts.onActivity!(); }, 60_000)
          : null;

        try {
          const sandbox = await getOrCreateSandbox();
          const envs = getSandboxEnvs();

          const requiredMs = timeout_seconds * 1000 + 60_000;
          if (requiredMs > DEFAULT_TIMEOUT_MS) {
            await sandbox.setTimeout(requiredMs);
          }

          logger.info("run_command tool: executing", {
            command: command.substring(0, 100),
            workdir,
          });
          const startedAt = Date.now();
          const GRACE_MS = 1000;
          const BATCH_MS = 1000;

          const flush = () => {
            if (buf && onStreamOutput && Date.now() - startedAt > GRACE_MS) {
              onStreamOutput(buf);
              didStream = true;
            }
            buf = "";
            timer = null;
          };

          const result = await sandbox.commands.run(command, {
            cwd: workdir || "/home/user",
            timeoutMs: timeout_seconds * 1000,
            envs,
            onStdout: onStreamOutput
              ? (data: string) => {
                  buf += data;
                  if (!timer) timer = setTimeout(flush, BATCH_MS);
                }
              : undefined,
            onStderr: opts?.onActivity
              ? () => { opts.onActivity!(); }
              : undefined,
          });

          if (keepAlive) clearInterval(keepAlive);
          if (timer) clearTimeout(timer);
          flush();

          const stdout = truncateOutput(result.stdout || "", 4000);
          const stderr = truncateOutput(result.stderr || "", 2000);

          logger.info("run_command tool: completed", {
            command: command.substring(0, 100),
            exitCode: result.exitCode,
            stdoutLength: (result.stdout || "").length,
            stderrLength: (result.stderr || "").length,
            didStream,
          });

          return {
            ok: true,
            exit_code: result.exitCode,
            stdout,
            stderr: stderr || undefined,
            ...(didStream ? { _streamed_to_user: true as const } : {}),
          };
        } catch (error: any) {
          if (keepAlive) clearInterval(keepAlive);
          if (timer) { clearTimeout(timer); timer = null; }
          buf = "";

          logger.error("run_command tool failed", {
            command: command.substring(0, 100),
            error: error.message,
          });

          if (error.message?.includes("timed out")) {
            return {
              ok: false,
              error: `Command timed out after ${timeout_seconds} seconds. Try increasing timeout_seconds or breaking the command into smaller steps.`,
            };
          }

          return {
            ok: false,
            error: `Command execution failed: ${error.message}`,
          };
        }
      },
    }),
  };
}

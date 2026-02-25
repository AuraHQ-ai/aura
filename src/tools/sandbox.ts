import { z } from "zod";
import {
  getOrCreateSandbox,
  getSandboxEnvs,
  truncateOutput,
  clearCachedSandbox,
} from "../lib/sandbox.js";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import { defineTool } from "../lib/tool.js";
import type { ScheduleContext } from "../db/schema.js";

/**
 * Create sandbox tools for the AI SDK.
 * Provides shell execution in an E2B cloud sandbox.
 * run_command is the universal primitive — use cat/head/tail for reading files,
 * heredocs for writing, git/rg/grep for search, etc.
 */
export function createSandboxTools(context?: ScheduleContext) {
  return {
    run_command: defineTool({
      description:
        "Execute a shell command in a sandboxed Linux VM. This is the universal primitive for computation: file ops, git, code execution (node, python), search (rg, grep), data processing (curl, jq), and self-modification via Claude Code (claude). Pre-installed: git, node, python, gh, gcloud, vercel CLI, ripgrep, curl, jq, claude. Install more with apt-get or pip. The sandbox persists between conversations — files and state are preserved across messages. Output is truncated; use head, tail, grep to filter. Break complex tasks into smaller commands. For complex workflows, check your skill notes first. Use higher timeouts (up to 750s) for long-running agent commands like Claude Code — the 750s ceiling leaves a 50s buffer before the Vercel function timeout at 800s.",
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
          .default(120)
          .describe(
            "Command timeout in seconds (default 120, max 750). Use higher timeouts for long-running agent commands like Claude Agent SDK or Codex CLI.",
          ),
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

        try {
          const sandbox = await getOrCreateSandbox();
          const envs = await getSandboxEnvs();

          logger.info("run_command tool: executing", {
            command: command.substring(0, 100),
            workdir,
          });

          const result = await sandbox.commands.run(command, {
            cwd: workdir || "/home/user",
            timeoutMs: timeout_seconds * 1000,
            envs,
          });

          const stdout = truncateOutput(result.stdout || "", 4000);
          const stderr = truncateOutput(result.stderr || "", 2000);

          logger.info("run_command tool: completed", {
            command: command.substring(0, 100),
            exitCode: result.exitCode,
            stdoutLength: (result.stdout || "").length,
            stderrLength: (result.stderr || "").length,
          });

          return {
            ok: true,
            exit_code: result.exitCode,
            stdout,
            stderr: stderr || undefined,
          };
        } catch (error: any) {
          // E2B's CommandExitError implements CommandResult with exitCode/stdout/stderr
          if ("exitCode" in error && typeof error.exitCode === "number") {
            const stdout = truncateOutput(error.stdout || "", 4000);
            const stderr = truncateOutput(error.stderr || "", 2000);

            logger.info("run_command tool: non-zero exit", {
              command: command.substring(0, 100),
              exitCode: error.exitCode,
              stdoutLength: (error.stdout || "").length,
              stderrLength: (error.stderr || "").length,
            });

            return {
              ok: true,
              exit_code: error.exitCode,
              stdout,
              stderr: stderr || undefined,
            };
          }

          logger.error("run_command tool failed", {
            command: command.substring(0, 100),
            error: error.message,
          });

          if (error.message?.includes("timed out")) {
            clearCachedSandbox();
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
      slack: {
        status: "Running a command in the sandbox...",
        detail: (input) =>
          input.command.length <= 120
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
  };
}

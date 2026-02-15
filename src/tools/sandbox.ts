import { tool } from "ai";
import { z } from "zod";
import {
  getOrCreateSandbox,
  pauseSandbox,
  truncateOutput,
} from "../lib/sandbox.js";
import { logger } from "../lib/logger.js";

/**
 * Create sandbox tools for the AI SDK.
 * Provides shell execution and filesystem access in an E2B cloud sandbox.
 */
export function createSandboxTools() {
  return {
    run_command: tool({
      description:
        "Execute a shell command in a sandboxed Linux VM. The sandbox has git, node, python, gh (GitHub CLI), gcloud, vercel CLI, ripgrep, curl, jq pre-installed. You can install additional tools with apt-get or pip. The sandbox persists between conversations -- files and state are preserved.",
      inputSchema: z.object({
        command: z
          .string()
          .describe(
            "The shell command to run, e.g. 'git clone https://github.com/org/repo.git' or 'npm test'",
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
          .max(300)
          .default(120)
          .describe("Command timeout in seconds (max 300)"),
      }),
      execute: async ({ command, workdir, timeout_seconds }) => {
        if (!process.env.E2B_API_KEY) {
          return {
            ok: false,
            error:
              "Sandbox execution is not available. E2B_API_KEY is not configured.",
          };
        }

        try {
          const sandbox = await getOrCreateSandbox();

          logger.info("run_command tool: executing", {
            command: command.substring(0, 100),
            workdir,
          });

          const result = await sandbox.commands.run(command, {
            cwd: workdir || "/home/user",
            timeoutMs: timeout_seconds * 1000,
          });

          const stdout = truncateOutput(result.stdout || "", 4000);
          const stderr = truncateOutput(result.stderr || "", 2000);

          logger.info("run_command tool: completed", {
            command: command.substring(0, 100),
            exitCode: result.exitCode,
            stdoutLength: (result.stdout || "").length,
            stderrLength: (result.stderr || "").length,
          });

          // Pause sandbox after execution to save credits
          await pauseSandbox();

          return {
            ok: true,
            exit_code: result.exitCode,
            stdout,
            stderr: stderr || undefined,
          };
        } catch (error: any) {
          logger.error("run_command tool failed", {
            command: command.substring(0, 100),
            error: error.message,
          });

          // Try to pause even on error
          await pauseSandbox().catch(() => {});

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

    read_sandbox_file: tool({
      description:
        "Read a file from the sandbox filesystem. Use this to inspect output files, logs, generated code, etc.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path to the file, e.g. '/home/user/repo/output.txt'"),
      }),
      execute: async ({ path }) => {
        if (!process.env.E2B_API_KEY) {
          return {
            ok: false,
            error: "Sandbox is not available. E2B_API_KEY is not configured.",
          };
        }

        try {
          const sandbox = await getOrCreateSandbox();

          const content = await sandbox.files.read(path);
          const truncated = truncateOutput(content, 8000);

          logger.info("read_sandbox_file tool called", {
            path,
            length: content.length,
          });

          await pauseSandbox();

          return {
            ok: true,
            path,
            content: truncated,
            length: content.length,
            truncated: content.length > 8000,
          };
        } catch (error: any) {
          logger.error("read_sandbox_file tool failed", {
            path,
            error: error.message,
          });
          await pauseSandbox().catch(() => {});

          return {
            ok: false,
            error: `Failed to read file: ${error.message}`,
          };
        }
      },
    }),

    write_sandbox_file: tool({
      description:
        "Write a file to the sandbox filesystem. Use this to create scripts, config files, or save generated content.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path for the file, e.g. '/home/user/script.py'"),
        content: z
          .string()
          .describe("The content to write to the file"),
      }),
      execute: async ({ path, content }) => {
        if (!process.env.E2B_API_KEY) {
          return {
            ok: false,
            error: "Sandbox is not available. E2B_API_KEY is not configured.",
          };
        }

        try {
          const sandbox = await getOrCreateSandbox();

          await sandbox.files.write(path, content);

          logger.info("write_sandbox_file tool called", {
            path,
            length: content.length,
          });

          await pauseSandbox();

          return {
            ok: true,
            message: `File written to ${path} (${content.length} bytes)`,
          };
        } catch (error: any) {
          logger.error("write_sandbox_file tool failed", {
            path,
            error: error.message,
          });
          await pauseSandbox().catch(() => {});

          return {
            ok: false,
            error: `Failed to write file: ${error.message}`,
          };
        }
      },
    }),

    read_own_source: tool({
      description:
        "Read a file from Aura's own source code (github.com/realadvisor/aura). Fast, no sandbox needed. Use this to understand how you work, debug issues, or review your own code before proposing changes.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "File path relative to repo root, e.g. 'src/pipeline/respond.ts' or 'src/personality/system-prompt.ts'",
          ),
      }),
      execute: async ({ path }) => {
        const token = process.env.GITHUB_TOKEN;
        if (!token) {
          return {
            ok: false,
            error:
              "GITHUB_TOKEN is not configured. Cannot read source code.",
          };
        }

        try {
          const url = `https://api.github.com/repos/realadvisor/aura/contents/${path}`;
          const response = await fetch(url, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github.raw",
              "User-Agent": "Aura/1.0",
            },
            signal: AbortSignal.timeout(10000),
          });

          if (!response.ok) {
            return {
              ok: false,
              error: `GitHub API returned ${response.status}: ${response.statusText}`,
            };
          }

          const content = await response.text();
          const truncated = truncateOutput(content, 8000);

          logger.info("read_own_source tool called", {
            path,
            length: content.length,
          });

          return {
            ok: true,
            path,
            content: truncated,
            length: content.length,
            truncated: content.length > 8000,
          };
        } catch (error: any) {
          logger.error("read_own_source tool failed", {
            path,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to read source: ${error.message}`,
          };
        }
      },
    }),
  };
}

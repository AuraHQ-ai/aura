import { tool } from "ai";
import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  getOrCreateSandbox,
  truncateOutput,
} from "../lib/sandbox.js";
import { logger } from "../lib/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Create sandbox tools for the AI SDK.
 * Provides shell execution in an E2B cloud sandbox.
 * run_command is the universal primitive — use cat/head/tail for reading files,
 * heredocs for writing, git/rg/grep for search, etc.
 */
export function createSandboxTools() {
  return {
    run_command: tool({
      description:
        "Execute a shell command in a sandboxed Linux VM. The sandbox has git, node, python, gh (GitHub CLI), gcloud, vercel CLI, ripgrep, curl, jq pre-installed. You can install additional tools with apt-get or pip. The sandbox persists between conversations -- files and state are preserved. Use cat/head/tail to read files, heredocs to write files, rg to search.",
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

    patch_own_code: tool({
      description:
        "Dispatch a Claude coding agent to edit your own source code and open a PR. " +
        "Write a detailed prompt describing exactly what to change and why — file paths, " +
        "function names, expected behavior. The agent has Read, Edit, Write, Bash, Glob, " +
        "Grep tools and works autonomously in your repo clone. Returns a PR URL on success. " +
        "Falls back to manual run_command workflow if ANTHROPIC_API_KEY is not configured.",
      inputSchema: z.object({
        prompt: z
          .string()
          .describe(
            "Detailed instructions for the coding agent — what to fix, where, and why. " +
            "Be specific about file paths, function names, and expected behavior. " +
            "The more precise, the better the result.",
          ),
        branch_name: z
          .string()
          .describe(
            "Git branch name for the PR, e.g. 'fix/slack-list-item-params'",
          ),
        pr_title: z.string().describe("Pull request title"),
        pr_body: z
          .string()
          .optional()
          .describe(
            "Pull request body/description. If omitted, one is generated from the agent's output and diff.",
          ),
      }),
      execute: async ({ prompt, branch_name, pr_title, pr_body }) => {
        if (!process.env.E2B_API_KEY) {
          return {
            ok: false,
            error:
              "Sandbox not available (E2B_API_KEY not configured). Use run_command for manual git workflow.",
          };
        }
        if (!process.env.ANTHROPIC_API_KEY) {
          return {
            ok: false,
            error:
              "ANTHROPIC_API_KEY not configured. Cannot dispatch coding agent. " +
              "Fall back to manual run_command workflow: clone, edit, commit, push, gh pr create.",
          };
        }
        if (!process.env.GITHUB_TOKEN) {
          return {
            ok: false,
            error:
              "GITHUB_TOKEN not configured. Cannot push branches or create PRs.",
          };
        }

        try {
          const sandbox = await getOrCreateSandbox();

          logger.info("patch_own_code: starting", {
            branch: branch_name,
            promptLength: prompt.length,
          });

          // Write the config file for the runner script
          const config = JSON.stringify({ prompt, branch_name, pr_title, pr_body });
          await sandbox.files.write("/home/user/agent-config.json", config);

          // Copy the runner template into the sandbox.
          // Try multiple paths: same dir as this file, src/tools/, project root src/tools/
          const templateCandidates = [
            join(__dirname, "agent-runner-template.mjs"),
            join(__dirname, "..", "tools", "agent-runner-template.mjs"),
            join(process.cwd(), "src", "tools", "agent-runner-template.mjs"),
          ];
          let runnerScript: string | null = null;
          for (const candidate of templateCandidates) {
            try {
              runnerScript = readFileSync(candidate, "utf-8");
              break;
            } catch {
              continue;
            }
          }
          if (!runnerScript) {
            return {
              ok: false,
              error: "Could not find agent-runner-template.mjs. Tried: " + templateCandidates.join(", "),
            };
          }
          await sandbox.files.write("/home/user/agent-runner.mjs", runnerScript);

          // Execute the runner (5 min backstop timeout; the script's own AbortController fires at 4.5 min)
          logger.info("patch_own_code: executing agent runner", { branch: branch_name });

          const result = await sandbox.commands.run(
            "node /home/user/agent-runner.mjs",
            {
              cwd: "/home/user",
              timeoutMs: 300_000,
            },
          );

          const stdout = (result.stdout || "").trim();
          const stderr = (result.stderr || "").trim();

          logger.info("patch_own_code: runner completed", {
            exitCode: result.exitCode,
            stdoutLength: stdout.length,
          });

          // Parse the JSON result from the runner script
          // The runner outputs a single JSON line to stdout
          const lastLine = stdout.split("\n").filter(Boolean).pop() || "";
          let parsed: any;
          try {
            parsed = JSON.parse(lastLine);
          } catch {
            return {
              ok: false,
              error: "Failed to parse agent runner output.",
              raw_stdout: truncateOutput(stdout, 3000),
              raw_stderr: truncateOutput(stderr, 1000),
            };
          }

          if (parsed.ok) {
            logger.info("patch_own_code: PR created", {
              pr_url: parsed.pr_url,
              cost_usd: parsed.cost_usd,
              num_turns: parsed.num_turns,
            });
          } else {
            logger.warn("patch_own_code: agent failed", {
              error: parsed.error,
              cost_usd: parsed.cost_usd,
            });
          }

          return parsed;
        } catch (error: any) {
          logger.error("patch_own_code failed", { error: error.message });

          if (error.message?.includes("timed out")) {
            return {
              ok: false,
              error:
                "Agent runner timed out after 5 minutes. The fix may be too complex " +
                "for a single dispatch. Try breaking it into smaller changes, or use " +
                "run_command for manual edits.",
            };
          }

          return {
            ok: false,
            error: `patch_own_code failed: ${error.message}`,
          };
        }
      },
    }),
  };
}

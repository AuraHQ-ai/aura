import { tool } from "ai";
import { z } from "zod";
import { db } from "../db/client.js";
import { notes } from "../db/schema.js";
import type { ScheduleContext } from "../db/schema.js";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";

const DEFAULT_REPO = "realadvisor/aura";
const DEFAULT_REPO_URL = `https://github.com/${DEFAULT_REPO}`;

/**
 * Create Cursor Cloud Agent tools for the AI SDK.
 * Provides async dispatch of Cursor agents for complex multi-file code tasks.
 */
export function createCursorAgentTools(context?: ScheduleContext) {
  return {
    dispatch_cursor_agent: tool({
      description:
        "Dispatch an async Cursor Cloud Agent to work on a code task in the Aura repo. " +
        "Use for complex multi-file fixes that would take >5 minutes in the sandbox. " +
        "The agent runs in the background (3-30 min) and results arrive via webhook DM. " +
        "Returns immediately with the agent ID. Admin-only.",
      inputSchema: z.object({
        issue_description: z
          .string()
          .describe(
            "Detailed description of the issue or task for the agent to work on",
          ),
        branch_prefix: z
          .string()
          .default("cursor")
          .describe(
            "Branch name prefix. The agent creates a branch like cursor/{slug}",
          ),
        ref: z
          .string()
          .optional()
          .describe(
            "Git ref (branch/tag/SHA) to base work on. Defaults to main",
          ),
        key_files: z
          .array(z.string())
          .optional()
          .describe(
            "List of key files for the agent to focus on, e.g. ['src/app.ts', 'src/tools/slack.ts']",
          ),
      }),
      execute: async ({ issue_description, branch_prefix, ref, key_files }) => {
        if (!isAdmin(context?.userId) && context?.userId !== "aura") {
          return {
            ok: false,
            error: "Only admins can dispatch Cursor agents.",
          };
        }

        if (!process.env.CURSOR_API_KEY) {
          return {
            ok: false,
            error:
              "Cursor agent dispatch is not available. CURSOR_API_KEY is not configured.",
          };
        }

        try {
          const { launchCursorAgent } = await import(
            "../lib/cursor-agent.js"
          );

          const slug = issue_description
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 40)
            .replace(/-$/, "");
          const branchName = `${branch_prefix}/${slug}`;

          const keyFilesSection =
            key_files && key_files.length > 0
              ? `\n\nKey files to focus on:\n${key_files.map((f) => `- ${f}`).join("\n")}`
              : "";

          const prompt = [
            `## Task\n\n${issue_description}`,
            `## Repository\n\nThis is the Aura project (github.com/${DEFAULT_REPO}) — a Slack AI assistant built with TypeScript, Hono, Vercel serverless, AI SDK v6, and PostgreSQL.`,
            keyFilesSection,
            `## Instructions\n\n- Use \`inputSchema\` (not \`parameters\`) for AI SDK v6 tools`,
            `- Use .js extensions in imports (ESM with "type": "module")`,
            `- Run \`npx tsc --noEmit\` before committing to verify types`,
            `- Never push directly to main — work on branch \`${branchName}\``,
            `- Create a PR with a clear description of changes`,
          ].join("\n\n");

          const webhookUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
            ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/webhook/cursor-agent`
            : process.env.CURSOR_WEBHOOK_URL ||
              "https://aura-alpha-five.vercel.app/api/webhook/cursor-agent";

          const webhookSecret = process.env.CURSOR_WEBHOOK_SECRET;

          const result = await launchCursorAgent({
            prompt,
            repository: DEFAULT_REPO_URL,
            ref: ref || "main",
            branchName,
            autoCreatePr: true,
            webhookUrl,
            webhookSecret: webhookSecret || undefined,
          });

          const trackingContent = [
            `## Cursor Agent Dispatch`,
            `- **Agent ID**: ${result.id}`,
            `- **Branch**: ${branchName}`,
            `- **Repo**: ${DEFAULT_REPO}`,
            `- **Requester**: ${context?.userId || "unknown"}`,
            `- **Channel**: ${context?.channelId || "unknown"}`,
            `- **Thread**: ${context?.threadTs || "none"}`,
            `- **Dispatched**: ${new Date().toISOString()}`,
            ``,
            `## Issue`,
            issue_description,
          ].join("\n");

          const sevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
          await db
            .insert(notes)
            .values({
              topic: `cursor-agent:${result.id}`,
              content: trackingContent,
              category: "plan",
              expiresAt: sevenDays,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: notes.topic,
              set: {
                content: trackingContent,
                category: "plan",
                expiresAt: sevenDays,
                updatedAt: new Date(),
              },
            });

          logger.info("dispatch_cursor_agent: launched", {
            agentId: result.id,
            branch: branchName,
            userId: context?.userId,
          });

          return {
            ok: true,
            agent_id: result.id,
            branch: branchName,
            dashboard_url:
              result.dashboardUrl ||
              `https://cursor.com/agents/${result.id}`,
            message: `Cursor agent dispatched (${result.id}). Working on branch \`${branchName}\`. Results will arrive via DM when done.`,
          };
        } catch (error: any) {
          logger.error("dispatch_cursor_agent failed", {
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to dispatch Cursor agent: ${error.message}`,
          };
        }
      },
    }),

    check_cursor_agent: tool({
      description:
        "Check the status of a previously dispatched Cursor Cloud Agent. " +
        "Returns the current status, PR URL (if finished), and summary.",
      inputSchema: z.object({
        agent_id: z
          .string()
          .describe("The agent ID returned by dispatch_cursor_agent"),
      }),
      execute: async ({ agent_id }) => {
        if (!isAdmin(context?.userId) && context?.userId !== "aura") {
          return {
            ok: false,
            error: "Only admins can check Cursor agent status.",
          };
        }

        if (!process.env.CURSOR_API_KEY) {
          return {
            ok: false,
            error:
              "Cursor agent is not available. CURSOR_API_KEY is not configured.",
          };
        }

        try {
          const { getCursorAgentStatus } = await import(
            "../lib/cursor-agent.js"
          );

          const status = await getCursorAgentStatus(agent_id);

          logger.info("check_cursor_agent: polled", {
            agentId: agent_id,
            status: status.status,
          });

          return {
            ok: true,
            agent_id: status.id,
            status: status.status,
            pr_url: status.target?.prUrl || null,
            branch: status.target?.branchName || null,
            summary: status.summary || null,
            created_at: status.createdAt || null,
            finished_at: status.finishedAt || null,
          };
        } catch (error: any) {
          logger.error("check_cursor_agent failed", {
            agentId: agent_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to check Cursor agent status: ${error.message}`,
          };
        }
      },
    }),
  };
}

import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { notes } from "@aura/db/schema";
import type { ScheduleContext } from "@aura/db/schema";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";

const DEFAULT_REPO = process.env.DEFAULT_GITHUB_REPO ?? "AuraHQ-ai/aura";

/**
 * Create Cursor Cloud Agent tools for the AI SDK.
 * Provides async dispatch of Cursor agents for complex multi-file code tasks.
 */
export function createCursorAgentTools(context?: ScheduleContext) {
  return {
    dispatch_cursor_agent: defineTool({
      description:
        "Dispatch an async Cursor Cloud Agent to work on a code task in the Aura repo. " +
        "Use for complex multi-file changes that would take >5 minutes in the sandbox (refactors, new features, multi-step bug fixes). " +
        "Do NOT use for simple one-line fixes or tasks that run_command handles in <2 minutes. " +
        "The agent runs in the background (3-30 min), creates a branch, makes changes, opens a PR, and results arrive via webhook DM. " +
        "Returns immediately with the agent ID — don't wait for it or poll in a loop. Save the agent ID in your reply so you can reference it later. Admin-only.",
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
        repository: z
          .string()
          .optional()
          .describe(
            "GitHub repository in owner/repo format, e.g. 'org/repo'. Defaults to 'AuraHQ-ai/aura'",
          ),
      }),
      execute: async ({ issue_description, branch_prefix, ref, key_files, repository }) => {
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

          const repo = repository || DEFAULT_REPO;
          const repoUrl = `https://github.com/${repo}`;

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

          const isAuraRepo = repo === DEFAULT_REPO;
          const repoDescription = isAuraRepo
            ? `This is the Aura project (github.com/${repo}) — a Slack AI assistant built with TypeScript, Hono, Vercel serverless, AI SDK v6, and PostgreSQL.`
            : `Repository: github.com/${repo}`;

          const instructions = isAuraRepo
            ? [
                `- Use \`inputSchema\` (not \`parameters\`) for AI SDK v6 tools`,
                `- Use .js extensions in imports (ESM with "type": "module")`,
                `- Run \`npx tsc --noEmit\` before committing to verify types`,
              ]
            : [];

          const prompt = [
            `## Task\n\n${issue_description}`,
            `## Repository\n\n${repoDescription}`,
            keyFilesSection,
            `## Instructions\n\n${[...instructions, `- Never push directly to main — work on branch \`${branchName}\``, `- Create a PR with a clear description of changes`].join("\n")}`,
          ].join("\n\n");

          const webhookUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
            ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/webhook/cursor-agent`
            : process.env.CURSOR_WEBHOOK_URL ||
              "https://aura-alpha-five.vercel.app/api/webhook/cursor-agent";

          const webhookSecret = process.env.CURSOR_WEBHOOK_SECRET;

          const result = await launchCursorAgent({
            prompt,
            repository: repoUrl,
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
            `- **Repo**: ${repo}`,
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
      slack: {
        status: "Dispatching Cursor agent...",
        detail: (i) => i.issue_description?.slice(0, 60),
      },
    }),

    check_cursor_agent: defineTool({
      description:
        "Check the status of a previously dispatched Cursor Cloud Agent. " +
        "Returns the current status, PR URL (if finished), and summary. Use when someone asks for a status update on a dispatched agent.",
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
      slack: {
        status: "Checking agent status...",
        detail: (i) => i.agent_id,
      },
    }),

    followup_cursor_agent: defineTool({
      description:
        "Send follow-up instructions to a finished Cursor agent. The agent continues working on the same branch/PR. " +
        "Use this instead of dispatching a new agent when iterating on the same task.",
      inputSchema: z.object({
        agent_id: z.string().describe("The agent ID to follow up on"),
        prompt: z
          .string()
          .describe("Follow-up instructions for the agent"),
      }),
      execute: async ({ agent_id, prompt }) => {
        if (!isAdmin(context?.userId) && context?.userId !== "aura") {
          return {
            ok: false,
            error: "Only admins can follow up on Cursor agents.",
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
          const { followupCursorAgent } = await import(
            "../lib/cursor-agent.js"
          );

          const result = await followupCursorAgent(agent_id, prompt);

          const followupNote = [
            `\n\n## Follow-up (${new Date().toISOString()})`,
            `- **Requester**: ${context?.userId || "unknown"}`,
            `- **Prompt**: ${prompt.slice(0, 500)}`,
          ].join("\n");

          const trackingRows = await db
            .select({ content: notes.content })
            .from(notes)
            .where(eq(notes.topic, `cursor-agent:${agent_id}`))
            .limit(1);

          if (trackingRows[0]?.content) {
            const sevenDays = new Date(
              Date.now() + 7 * 24 * 60 * 60 * 1000,
            );
            await db
              .insert(notes)
              .values({
                topic: `cursor-agent:${agent_id}`,
                content: trackingRows[0].content + followupNote,
                category: "plan",
                expiresAt: sevenDays,
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: notes.topic,
                set: {
                  content: trackingRows[0].content + followupNote,
                  expiresAt: sevenDays,
                  updatedAt: new Date(),
                },
              });
          }

          logger.info("followup_cursor_agent: sent", {
            agentId: agent_id,
            userId: context?.userId,
          });

          return {
            ok: true,
            agent_id: result.id,
            status: result.status,
            message: `Follow-up sent to agent ${agent_id}. It will continue working on the same branch/PR.`,
          };
        } catch (error: any) {
          logger.error("followup_cursor_agent failed", {
            agentId: agent_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to follow up on Cursor agent: ${error.message}`,
          };
        }
      },
      slack: { status: "Following up on agent..." },
    }),

    get_cursor_conversation: defineTool({
      description:
        "Get the full conversation history of a Cursor agent — every step it took, files it read, changes it made.",
      inputSchema: z.object({
        agent_id: z.string().describe("The agent ID"),
      }),
      execute: async ({ agent_id }) => {
        if (!isAdmin(context?.userId) && context?.userId !== "aura") {
          return {
            ok: false,
            error: "Only admins can view Cursor agent conversations.",
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
          const { getCursorConversation } = await import(
            "../lib/cursor-agent.js"
          );

          const conversation = await getCursorConversation(agent_id);

          logger.info("get_cursor_conversation: fetched", {
            agentId: agent_id,
          });

          return { ok: true, agent_id, conversation };
        } catch (error: any) {
          logger.error("get_cursor_conversation failed", {
            agentId: agent_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to get conversation: ${error.message}`,
          };
        }
      },
      slack: { status: "Reading agent conversation..." },
    }),

    stop_cursor_agent: defineTool({
      description: "Stop a running Cursor agent.",
      inputSchema: z.object({
        agent_id: z.string().describe("The agent ID to stop"),
      }),
      execute: async ({ agent_id }) => {
        if (!isAdmin(context?.userId) && context?.userId !== "aura") {
          return {
            ok: false,
            error: "Only admins can stop Cursor agents.",
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
          const { stopCursorAgent } = await import(
            "../lib/cursor-agent.js"
          );

          const result = await stopCursorAgent(agent_id);

          logger.info("stop_cursor_agent: stopped", {
            agentId: agent_id,
          });

          return {
            ok: true,
            agent_id,
            result,
            message: `Agent ${agent_id} has been stopped.`,
          };
        } catch (error: any) {
          logger.error("stop_cursor_agent failed", {
            agentId: agent_id,
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to stop Cursor agent: ${error.message}`,
          };
        }
      },
      slack: { status: "Stopping agent..." },
    }),

    list_cursor_agents: defineTool({
      description:
        "List Cursor agents. Optionally filter by PR URL to find agents that worked on a specific PR.",
      inputSchema: z.object({
        pr_url: z
          .string()
          .optional()
          .describe("Filter by PR URL"),
      }),
      execute: async ({ pr_url }) => {
        if (!isAdmin(context?.userId) && context?.userId !== "aura") {
          return {
            ok: false,
            error: "Only admins can list Cursor agents.",
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
          const { listCursorAgents } = await import(
            "../lib/cursor-agent.js"
          );

          const agents = await listCursorAgents(pr_url);

          logger.info("list_cursor_agents: fetched", {
            prUrl: pr_url,
          });

          return { ok: true, agents };
        } catch (error: any) {
          logger.error("list_cursor_agents failed", {
            error: error.message,
          });
          return {
            ok: false,
            error: `Failed to list Cursor agents: ${error.message}`,
          };
        }
      },
      slack: { status: "Listing agents..." },
    }),
  };
}

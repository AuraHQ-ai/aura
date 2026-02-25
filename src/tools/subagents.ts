import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import type { WebClient } from "@slack/web-api";
import { logger } from "../lib/logger.js";
import { isAdmin } from "../lib/permissions.js";
import { runSubagent } from "../lib/subagent.js";
import { getFastModel, getMainModel } from "../lib/ai.js";
import type { ScheduleContext } from "../db/schema.js";

import { createNoteTools } from "./notes.js";
import { createBigQueryTools } from "./bigquery.js";
import { createWebTools } from "./web.js";
import { createSandboxTools } from "./sandbox.js";
import { createEmailTools, createGmailEATools } from "./email.js";
import { createEmailSyncTools } from "./email-sync.js";
import { createSheetsTools } from "./sheets.js";
import { createConversationSearchTools } from "./conversations.js";

/**
 * Scope presets map scope hints to tool subsets.
 * The parent agent picks the scope at runtime based on the task.
 */
async function buildToolScope(
  scope: string,
  client: WebClient,
  context?: ScheduleContext,
) {
  switch (scope) {
    case "email":
      return {
        ...createEmailTools(),
        ...createGmailEATools(),
        ...createEmailSyncTools(client, context),
        ...createNoteTools(context),
      };
    case "data":
      return {
        ...createBigQueryTools(context),
        ...createSheetsTools(),
        ...createNoteTools(context),
      };
    case "web":
      return {
        ...createWebTools(),
        ...createSandboxTools(context),
      };
    case "slack": {
      const { createSlackTools } = await import("./slack.js");
      return { ...createSlackTools(client, context) };
    }
    case "notes":
      return {
        ...createNoteTools(context),
        ...createConversationSearchTools(context),
      };
    case "all":
    default: {
      const { createSlackTools } = await import("./slack.js");
      return createSlackTools(client, context);
    }
  }
}

export function createSubagentTools(
  client: WebClient,
  context?: ScheduleContext,
) {
  return {
    run_subagent: defineTool({
      description:
        "Launch a subagent for parallel fan-out. Call this tool MULTIPLE TIMES in the same tool-call block to run tasks concurrently — e.g. sweep 4 market channels simultaneously, or triage emails while analyzing data. Each subagent runs in its own isolated context with scoped tools, preventing context pollution. Returns a compressed summary. The primary value is parallelism and performance — use when you can split work into independent pieces that don't depend on each other's results. Admin-only.",
      inputSchema: z.object({
        task: z
          .string()
          .describe(
            "What the subagent should do. Be specific — this is the user prompt.",
          ),
        system_prompt: z
          .string()
          .optional()
          .describe(
            "Optional system prompt for the subagent. If omitted, a generic 'execute this task and return a summary' prompt is used.",
          ),
        scope: z
          .enum(["email", "data", "web", "slack", "notes", "all"])
          .default("all")
          .describe(
            "Tool scope hint. 'email' = email tools + notes. 'data' = BigQuery + Sheets + notes. 'web' = web search + sandbox. 'slack' = full Slack toolset. 'notes' = notes + conversation search. 'all' = everything.",
          ),
        model_preference: z
          .enum(["fast", "main"])
          .default("fast")
          .describe(
            "Which model to use. 'fast' = Haiku (cheap, good for triage/summarization). 'main' = same model as parent (expensive, for complex reasoning).",
          ),
        max_steps: z
          .number()
          .min(1)
          .max(100)
          .default(50)
          .describe("Maximum agent loop steps for the subagent."),
      }),
      execute: async ({
        task,
        system_prompt,
        scope,
        model_preference,
        max_steps,
      }) => {
        if (context?.userId && !isAdmin(context.userId)) {
          return { ok: false as const, error: "Admin-only tool" };
        }

        const resolvedModel =
          model_preference === "main"
            ? await getMainModel()
            : { model: await getFastModel() };
        const model = resolvedModel.model;

        const tools = await buildToolScope(scope, client, context);

        const safeTools = { ...tools };
        delete (safeTools as Record<string, unknown>).run_subagent;

        const defaultSystemPrompt =
          "You are a focused subtask agent. Execute the task below thoroughly, then provide a clear, concise summary of your findings and any actions taken. Be specific with data, names, and numbers.";

        const result = await runSubagent({
          model,
          tools: safeTools,
          systemPrompt: system_prompt || defaultSystemPrompt,
          userPrompt: task,
          maxSteps: max_steps,
        });

        return {
          ok: true as const,
          summary: result.text,
          usage: result.usage,
          stepCount: result.stepCount,
          toolCallCount: result.toolCalls.length,
          errors: result.toolCalls.filter((tc) => tc.isError).length,
        };
      },
      slack: {
        status: "Running subagent...",
        detail: (i) => i.task?.slice(0, 60),
      },
    }),
  };
}

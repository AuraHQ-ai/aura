import { generateText, stepCountIs, type ToolSet } from "ai";
import { logger } from "./logger.js";

/** Model type accepted by generateText */
type GenerateTextModel = Parameters<typeof generateText>[0]["model"];

// ── Types ────────────────────────────────────────────────────────────────────

export interface SubagentConfig {
  /** Model to use for the subagent (e.g. fast model for triage, main model for investigation) */
  model: GenerateTextModel;
  /** Subset of tools the subagent can use */
  tools: ToolSet;
  /** System prompt scoped to the subagent's task */
  systemPrompt: string;
  /** User prompt describing what the subagent should do */
  userPrompt: string;
  /** Maximum number of agentic loop steps (default 50) */
  maxSteps?: number;
}

export interface SubagentResult {
  /** Final text output from the subagent */
  text: string;
  /** Token usage for the entire subagent run */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Number of steps the subagent took */
  stepCount: number;
  /** Tool calls made during execution (name + truncated output) */
  toolCalls: Array<{ toolName: string; isError: boolean }>;
}

// ── Subagent Runner ──────────────────────────────────────────────────────────

/**
 * Run a subagent with isolated context.
 *
 * Subagents are mini agent loops that run a focused task with a scoped set of
 * tools and their own context window. The parent agent only sees the compressed
 * result, keeping its context clean for the broader conversation.
 *
 * Uses `generateText` (non-streaming) with its own tool loop.
 */
export async function runSubagent(config: SubagentConfig): Promise<SubagentResult> {
  const {
    model,
    tools,
    systemPrompt,
    userPrompt,
    maxSteps = 50,
  } = config;

  const startMs = Date.now();

  logger.info("subagent: starting", {
    toolCount: Object.keys(tools).length,
    maxSteps,
    promptLength: userPrompt.length,
  });

  const result = await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    tools,
    stopWhen: stepCountIs(maxSteps),
  });

  const { text, steps, totalUsage: usage } = result;

  const toolCalls = steps.flatMap(
    (step) =>
      step.toolCalls?.map((tc) => {
        const tr = step.toolResults?.find(
          (r) => r.toolCallId === tc.toolCallId,
        );
        const output = tr?.output;
        const isError =
          (tr as any)?.isError === true ||
          (output != null &&
            typeof output === "object" &&
            "ok" in (output as Record<string, unknown>) &&
            (output as Record<string, unknown>).ok === false);
        return { toolName: tc.toolName, isError };
      }) ?? [],
  );

  const elapsedMs = Date.now() - startMs;

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? (inputTokens + outputTokens);

  logger.info("subagent: completed", {
    elapsedMs,
    stepCount: steps.length,
    toolCallCount: toolCalls.length,
    inputTokens,
    outputTokens,
    textLength: text.length,
  });

  return {
    text: text || "Subagent completed without text output.",
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
    },
    stepCount: steps.length,
    toolCalls,
  };
}

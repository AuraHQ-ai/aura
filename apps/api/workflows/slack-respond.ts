/**
 * Durable Slack respond pipeline — one workflow run per assistant turn.
 *
 * Architecture (issue #1111): "streaming to Slack" is not a held socket — it
 * is a sequence of stateless `chat.appendStream` HTTP calls. The only real
 * stream (the Anthropic SSE) lives entirely within a single model call, so
 * the unit of atomicity is one model-call + append cycle:
 *
 * - Workflow  = one assistant turn (the agent loop)
 * - Step      = one model call (SSE consumed fully inside the step) plus the
 *               resulting Slack appends and tool executions
 * - SIGKILL mid-turn → the workflow resumes from the last completed step.
 *   Worst case we re-run one model call instead of losing the turn.
 *
 * Known seam: Slack stream sessions expire after a few minutes of silence. A
 * resume that arrives late continues in a NEW message bubble instead of
 * appending to the old one — recoverable UX, accepted in the issue.
 *
 * Enabled via the `AURA_WDK_SLACK_RESPOND` env var or the
 * `wdk_slack_respond` setting (see src/pipeline/slack-workflow.ts). The
 * legacy in-process path in respond.ts remains the default.
 */
import type { ModelMessage } from "ai";
import type { FileContentPart } from "../src/lib/files.js";
import type { MessageContext } from "../src/pipeline/context.js";
import type { ToolCallRecord } from "../src/pipeline/respond.js";

export interface SlackRespondWorkflowInput {
  /** Prompt layers (already assembled by the pipeline). */
  stablePrefix: string;
  environmentContext: string;
  conversationContext: string;
  dynamicContext?: string;
  userMessage: string;
  files?: FileContentPart[];
  /** Delivery coordinates. */
  channelId: string;
  threadTs: string;
  teamId?: string;
  recipientUserId?: string;
  /** Identity / bookkeeping. */
  userId: string;
  workspaceId?: string;
  timezone?: string;
  invocationId: string;
  modelId: string;
  /** Inputs for runBackgroundTasks (persistence parity with legacy path). */
  background: {
    context: MessageContext;
    event: Record<string, unknown>;
    displayName: string;
    threadMessageCount: number;
    recentThreadMessages: Array<{ displayName: string; text: string }>;
    threadMessagesElided: boolean;
    systemPrompt: string;
  };
}

/** Serializable Slack stream state carried between steps. */
export interface SlackStreamState {
  /** ts of the current streaming message bubble, if one is open. */
  streamTs: string | null;
  /** Approx. characters appended to the current bubble. */
  charCount: number;
  /** Streaming unsupported on this channel — buffer and post at finalize. */
  streamingFailed: boolean;
  /** Number of bubbles opened so far (continuations / expiry recoveries). */
  bubbleCount: number;
}

interface StepRecord {
  text: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults?: Array<{ toolCallId: string; toolName: string; output: unknown }>;
  finishReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  response?: { modelId?: string };
}

interface SlackAgentStepResult {
  superseded: boolean;
  responseMessages: ModelMessage[];
  finishReason: string;
  text: string;
  streamState: SlackStreamState;
  stepRecord: StepRecord;
  toolRecords: ToolCallRecord[];
  hadToolFailure: boolean;
  stepModelId: string;
}

const SLACK_STEP_LIMIT = 250;
const WRAP_UP_THRESHOLD = 200;
const STREAM_SPLIT_THRESHOLD = 9_000;
const STREAM_CONTINUATION_TOMBSTONE = "_(continuing in a new message...)_";
const EMPTY_COMPLETION_RELAUNCH_PROMPT =
  "(continue - you ended without responding. Summarize what you found.)";

// ── Steps ────────────────────────────────────────────────────────────────────

/**
 * One model call + the resulting Slack appends and tool executions.
 * Everything non-serializable (Slack client, model, tools) is rebuilt from
 * env + ctx inside the step.
 */
async function runSlackAgentStep(
  input: SlackRespondWorkflowInput,
  messages: ModelMessage[],
  streamState: SlackStreamState,
  stepIndex: number,
  escalate: boolean,
): Promise<SlackAgentStepResult> {
  "use step";
  const { streamText, isStepCount } = await import("ai");
  const { WebClient } = await import("@slack/web-api");
  const { gateway } = await import("@ai-sdk/gateway");
  const {
    withAnthropicFallback,
    getEscalationModel,
    buildCachedSystemMessages,
  } = await import("../src/lib/ai.js");
  const { createSlackTools } = await import("../src/tools/slack.js");
  const { getDeferredToolManifest } = await import("../src/tools/deferred.js");
  const { appendDeferredToolsBlock } = await import("../src/personality/system-prompt.js");
  const { getProviderThinkingOptions } = await import("../src/pipeline/prepare-step.js");
  const { isInvocationCurrent } = await import("../src/lib/invocation-lock.js");
  const { executionContext } = await import("../src/lib/tool.js");
  const { getSlackMeta } = await import("../src/lib/tool.js");
  const { pruneMessages } = await import("ai");
  const { logger } = await import("../src/lib/logger.js");

  const state: SlackStreamState = { ...streamState };

  // ── Invocation staleness: one check per model call ──────────────────
  try {
    const current = await isInvocationCurrent(
      input.channelId,
      input.threadTs,
      input.invocationId,
    );
    if (!current) {
      return supersededResult(state);
    }
  } catch {
    // assume still current on check failure
  }

  const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

  // ── Model (with workflow-level escalation) ──────────────────────────
  let stepModelId = input.modelId;
  let model: any;
  if (escalate) {
    try {
      const escalation = await getEscalationModel();
      stepModelId = escalation.modelId;
      model = escalation.model;
      logger.warn("slackRespondWorkflow: using escalation model", {
        stepIndex,
        modelId: stepModelId,
      });
    } catch {
      model = withAnthropicFallback(gateway(input.modelId), input.modelId);
    }
  } else {
    model = withAnthropicFallback(gateway(input.modelId), input.modelId);
  }

  // ── Tools (full Slack tool set, deferred discovery intact) ──────────
  const scheduleContext = {
    userId: input.userId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    workspaceId: input.workspaceId,
    timezone: input.timezone,
  };
  const tools = await createSlackTools(
    slackClient,
    scheduleContext as any,
    stepModelId,
    input.invocationId,
  );

  const environmentContext =
    appendDeferredToolsBlock(
      input.environmentContext,
      getDeferredToolManifest(tools),
    ) ?? input.environmentContext;

  let dynamicContext = input.dynamicContext;
  if (stepIndex >= WRAP_UP_THRESHOLD) {
    const wrapUp =
      `IMPORTANT: You're approaching your step limit (${stepIndex}/${SLACK_STEP_LIMIT}). ` +
      "Start wrapping up — summarize your findings and post results now. " +
      "Do not start new investigations or long tool chains.";
    dynamicContext = dynamicContext ? `${dynamicContext}\n\n${wrapUp}` : wrapUp;
  }

  const system = buildCachedSystemMessages(
    input.stablePrefix,
    environmentContext,
    input.conversationContext,
    dynamicContext,
  );

  const providerOptions = await getProviderThinkingOptions(stepModelId, 8000).catch(
    () => ({}),
  );

  // ── Slack append helpers ─────────────────────────────────────────────
  async function openStream(): Promise<void> {
    if (state.streamingFailed || state.streamTs) return;
    try {
      const params: Record<string, any> = {
        channel: input.channelId,
        thread_ts: input.threadTs,
        task_display_mode: "timeline",
      };
      if (input.teamId) params.recipient_team_id = input.teamId;
      if (input.recipientUserId) params.recipient_user_id = input.recipientUserId;
      const res: any = await slackClient.apiCall("chat.startStream", params);
      state.streamTs = res.ts;
      state.charCount = 0;
      state.bubbleCount += 1;
    } catch (error: any) {
      logger.warn("slackRespondWorkflow: chat.startStream failed — falling back to postMessage", {
        error: error?.data?.error || error?.message,
        channelId: input.channelId,
      });
      state.streamingFailed = true;
    }
  }

  async function append(chunks: Array<Record<string, unknown>>): Promise<void> {
    if (state.streamingFailed) return;
    if (!state.streamTs) await openStream();
    if (!state.streamTs) return;
    try {
      await slackClient.apiCall("chat.appendStream", {
        channel: input.channelId,
        ts: state.streamTs,
        chunks,
      });
      state.charCount += JSON.stringify(chunks).length;
    } catch (error: any) {
      const code = error?.data?.error;
      if (code === "message_not_in_streaming_state" || code === "msg_too_long") {
        // Known seam: the stream session expired (e.g. resume after a kill)
        // or overflowed — continue in a new bubble.
        logger.info("slackRespondWorkflow: stream session unusable, opening new bubble", {
          code,
          channelId: input.channelId,
        });
        state.streamTs = null;
        await openStream();
        if (state.streamTs) {
          try {
            await slackClient.apiCall("chat.appendStream", {
              channel: input.channelId,
              ts: state.streamTs,
              chunks,
            });
            state.charCount += JSON.stringify(chunks).length;
            return;
          } catch {
            // fall through to failure handling
          }
        }
        state.streamingFailed = true;
      } else if (code === "channel_type_not_supported" || code === "invalid_blocks") {
        state.streamingFailed = true;
      } else {
        logger.warn("slackRespondWorkflow: append failed (continuing)", {
          code: code || error?.message,
        });
      }
    }
  }

  async function splitIfNeeded(): Promise<void> {
    if (state.streamingFailed || !state.streamTs) return;
    if (state.charCount < STREAM_SPLIT_THRESHOLD) return;
    try {
      await slackClient.apiCall("chat.appendStream", {
        channel: input.channelId,
        ts: state.streamTs,
        chunks: [{ type: "markdown_text", text: `\n\n${STREAM_CONTINUATION_TOMBSTONE}` }],
      });
      await slackClient.apiCall("chat.stopStream", {
        channel: input.channelId,
        ts: state.streamTs,
      });
    } catch {
      // best effort — the new bubble matters more
    }
    state.streamTs = null;
    await openStream();
  }

  function truncate(s: string | undefined, max: number): string | undefined {
    if (!s) return undefined;
    return s.length <= max ? s : s.slice(0, max - 1) + "…";
  }

  // ── Run one model call ───────────────────────────────────────────────
  const abortController = new AbortController();
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const resetTimer = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => abortController.abort("inactivity"), 180_000);
  };
  resetTimer();

  // Keep the Slack stream session alive during long tool executions.
  const pendingTools = new Set<string>();
  const keepAlive = setInterval(() => {
    if (pendingTools.size > 0 && !state.streamingFailed && state.streamTs) {
      void append([{ type: "markdown_text", text: " " }]);
      resetTimer();
    }
  }, 20_000);

  const prunedMessages = pruneMessages({
    messages,
    reasoning: "before-last-message",
  });

  let text = "";
  const toolRecords: ToolCallRecord[] = [];
  let textBuffer = "";
  let lastFlush = Date.now();

  async function flushText(force = false): Promise<void> {
    if (!textBuffer) return;
    if (!force && textBuffer.length < 250 && Date.now() - lastFlush < 700) return;
    const chunk = textBuffer;
    textBuffer = "";
    lastFlush = Date.now();
    await append([{ type: "markdown_text", text: chunk }]);
    await splitIfNeeded();
  }

  try {
    const result = executionContext.run(
      {
        triggeredBy: input.userId,
        triggerType: "user_message",
        callingUserId: input.userId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        workspaceId: input.workspaceId,
      },
      () =>
        streamText({
          model,
          instructions: system as any,
          messages: prunedMessages,
          tools,
          stopWhen: isStepCount(1),
          abortSignal: abortController.signal,
          providerOptions: providerOptions as any,
          onError: () => {
            // Errors surface via the awaited promises below; this prevents
            // unhandled rejection noise inside the step.
          },
        }),
    );

    for await (const chunk of result.stream) {
      resetTimer();
      switch (chunk.type) {
        case "text-delta": {
          text += chunk.text;
          textBuffer += chunk.text;
          await flushText();
          break;
        }
        case "tool-input-start": {
          const meta = getSlackMeta((tools as any)[(chunk as any).toolName]);
          await flushText(true);
          await append([
            {
              type: "task_update",
              id: (chunk as any).toolCallId,
              title: meta?.status ?? "Working on it...",
              status: "in_progress",
            },
          ]);
          break;
        }
        case "tool-call": {
          const meta = getSlackMeta((tools as any)[chunk.toolName]);
          const inputArgs = (chunk as any).input ?? {};
          let details: string | undefined;
          try {
            details = meta?.detail?.(inputArgs);
          } catch { /* partial input args */ }
          await flushText(true);
          await append([
            {
              type: "task_update",
              id: chunk.toolCallId,
              title: meta?.status ?? "Working on it...",
              status: "in_progress",
              ...(details ? { details: truncate(details, 200) } : {}),
            },
          ]);
          pendingTools.add(chunk.toolCallId);
          break;
        }
        case "tool-result": {
          const meta = getSlackMeta((tools as any)[chunk.toolName]);
          const output = chunk.output as any;
          const isError = Boolean(
            output && typeof output === "object" && "ok" in output && output.ok === false,
          );
          let taskOutput: string | undefined;
          try {
            taskOutput = meta?.output?.(output);
          } catch { /* display-only */ }
          taskOutput ??= isError && output?.error ? String(output.error) : undefined;
          await append([
            {
              type: "task_update",
              id: chunk.toolCallId,
              title: meta?.status ?? "Done",
              status: isError ? "error" : "complete",
              ...(taskOutput ? { output: truncate(taskOutput, 200) } : {}),
            },
          ]);
          toolRecords.push({
            name: chunk.toolName,
            input: truncate(JSON.stringify((chunk as any).input ?? {}), 1500) ?? "{}",
            output: truncate(JSON.stringify(output ?? null), 1500) ?? "null",
            is_error: isError,
          });
          pendingTools.delete(chunk.toolCallId);
          break;
        }
        case "tool-error": {
          const errToolName = (chunk as any).toolName;
          const errToolCallId = (chunk as any).toolCallId;
          const meta = getSlackMeta((tools as any)[errToolName]);
          const err = (chunk as any).error;
          const errorMsg = err instanceof Error ? err.message : String(err);
          await append([
            {
              type: "task_update",
              id: errToolCallId,
              title: meta?.status ?? "Failed",
              status: "error",
              output: truncate(errorMsg, 200),
            },
          ]);
          toolRecords.push({
            name: errToolName || "unknown",
            input: "{}",
            output: truncate(JSON.stringify({ error: errorMsg }), 1500) ?? "{}",
            is_error: true,
          });
          pendingTools.delete(errToolCallId);
          break;
        }
      }
    }

    await flushText(true);

    const [response, finishReason, usage] = await Promise.all([
      result.response,
      result.finishReason,
      result.usage,
    ]);

    const hadToolFailure = toolRecords.some((r) => r.is_error);

    return {
      superseded: false,
      responseMessages: response.messages as ModelMessage[],
      finishReason: String(finishReason),
      text,
      streamState: state,
      stepRecord: {
        text,
        toolCalls: toolRecords.map((r) => ({
          toolCallId: "",
          toolName: r.name,
          input: safeParse(r.input),
        })),
        toolResults: toolRecords.map((r) => ({
          toolCallId: "",
          toolName: r.name,
          output: safeParse(r.output),
        })),
        finishReason: String(finishReason),
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
        },
        response: { modelId: response.modelId },
      },
      toolRecords,
      hadToolFailure,
      stepModelId,
    };
  } finally {
    clearTimeout(inactivityTimer);
    clearInterval(keepAlive);
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function supersededResult(state: SlackStreamState): SlackAgentStepResult {
  return {
    superseded: true,
    responseMessages: [],
    finishReason: "superseded",
    text: "",
    streamState: state,
    stepRecord: { text: "" },
    toolRecords: [],
    hadToolFailure: false,
    stepModelId: "",
  };
}

/**
 * Close the Slack stream (or deliver via postMessage when streaming was
 * unsupported) and run the same background persistence as the legacy path.
 */
async function finalizeSlackRespond(params: {
  input: SlackRespondWorkflowInput;
  streamState: SlackStreamState;
  fullText: string;
  steps: StepRecord[];
  stepModelIds: string[];
  toolRecords: ToolCallRecord[];
  outcome: "completed" | "superseded" | "failed";
}): Promise<void> {
  "use step";
  const { WebClient } = await import("@slack/web-api");
  const { runBackgroundTasks } = await import("../src/pipeline/index.js");
  const { logger } = await import("../src/lib/logger.js");

  const { input, streamState, fullText, steps, stepModelIds, toolRecords, outcome } = params;
  const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

  // ── Close / deliver ──────────────────────────────────────────────────
  try {
    if (streamState.streamTs && !streamState.streamingFailed) {
      const stopParams: Record<string, any> = {
        channel: input.channelId,
        ts: streamState.streamTs,
      };
      if (outcome === "superseded") {
        await slackClient.apiCall("chat.appendStream", {
          channel: input.channelId,
          ts: streamState.streamTs,
          chunks: [{ type: "markdown_text", text: "\n\n_(interrupted by a newer message)_" }],
        }).catch(() => {});
      }
      await slackClient.apiCall("chat.stopStream", stopParams);
    } else if (outcome === "completed" && fullText.trim()) {
      // Streaming never worked on this channel — deliver the buffered text.
      await slackClient.chat.postMessage({
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: fullText,
      });
    } else if (outcome === "completed" && !fullText.trim() && toolRecords.length > 0) {
      await slackClient.chat.postMessage({
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: "_I ran the tools but didn't get usable output back. Can you tell me what to retry?_",
      });
    }
  } catch (error: any) {
    logger.error("slackRespondWorkflow: finalize delivery failed", {
      error: error?.data?.error || error?.message,
      channelId: input.channelId,
    });
  }

  if (outcome !== "completed") return;

  // ── Persistence parity with the legacy path ──────────────────────────
  const totalUsage = steps.reduce(
    (acc, s) => ({
      inputTokens: acc.inputTokens + (s.usage?.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (s.usage?.outputTokens ?? 0),
      totalTokens: acc.totalTokens + (s.usage?.totalTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );

  try {
    await runBackgroundTasks({
      context: input.background.context,
      event: input.background.event as any,
      response: fullText,
      toolCalls: toolRecords,
      displayName: input.background.displayName,
      client: slackClient,
      threadMessageCount: input.background.threadMessageCount,
      recentThreadMessages: input.background.recentThreadMessages,
      threadMessagesElided: input.background.threadMessagesElided,
      tokenUsage: totalUsage,
      modelId: input.modelId,
      systemPrompt: input.background.systemPrompt,
      userPrompt: input.userMessage,
      stepsPromise: Promise.resolve(steps),
      stepModelIds,
      replyThreadTs: input.threadTs,
    });
  } catch (error: any) {
    logger.error("slackRespondWorkflow: background tasks failed", {
      error: error?.message || String(error),
      channelId: input.channelId,
    });
  }
}

// ── Workflow ─────────────────────────────────────────────────────────────────

export async function slackRespondWorkflow(input: SlackRespondWorkflowInput) {
  "use workflow";

  // Initial user message (pure construction — files are content parts).
  const initialContent: ModelMessage =
    input.files && input.files.length > 0
      ? {
          role: "user",
          content: [{ type: "text", text: input.userMessage }, ...(input.files as any[])],
        }
      : { role: "user", content: input.userMessage };

  let messages: ModelMessage[] = [initialContent];
  let streamState: SlackStreamState = {
    streamTs: null,
    charCount: 0,
    streamingFailed: false,
    bubbleCount: 0,
  };

  const steps: StepRecord[] = [];
  const stepModelIds: string[] = [];
  const toolRecords: ToolCallRecord[] = [];
  let fullText = "";
  let failureCount = 0;
  let escalate = false;
  let relaunchedForEmptyCompletion = false;

  for (let stepIndex = 0; stepIndex < SLACK_STEP_LIMIT; stepIndex++) {
    const r = await runSlackAgentStep(input, messages, streamState, stepIndex, escalate);

    if (r.superseded) {
      await finalizeSlackRespond({
        input,
        streamState,
        fullText,
        steps,
        stepModelIds,
        toolRecords,
        outcome: "superseded",
      });
      return { interrupted: true, text: fullText };
    }

    messages = [...messages, ...r.responseMessages];
    streamState = r.streamState;
    fullText += r.text;
    steps.push(r.stepRecord);
    stepModelIds.push(r.stepModelId);
    toolRecords.push(...r.toolRecords);
    if (r.hadToolFailure) failureCount++;
    if (!escalate && stepIndex > 15 && failureCount >= 3) {
      escalate = true;
    }

    if (r.finishReason === "tool-calls") continue;

    // Empty-completion relaunch (legacy parity): the model ran tools but
    // produced no user-visible text — nudge it once to summarize.
    if (
      !relaunchedForEmptyCompletion &&
      fullText.trim().length === 0 &&
      toolRecords.length > 0
    ) {
      relaunchedForEmptyCompletion = true;
      messages = [
        ...messages,
        { role: "user", content: EMPTY_COMPLETION_RELAUNCH_PROMPT },
      ];
      continue;
    }

    break;
  }

  await finalizeSlackRespond({
    input,
    streamState,
    fullText,
    steps,
    stepModelIds,
    toolRecords,
    outcome: "completed",
  });

  return { interrupted: false, text: fullText };
}

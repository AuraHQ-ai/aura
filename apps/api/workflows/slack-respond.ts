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
 * Cost bounds (issue #1320): durable execution removed the 800s SIGKILL that
 * implicitly capped turns, so the loop enforces the same wall-clock budget as
 * the legacy prepareStep path (#1318): the baseline is recorded once in a
 * step (survives replay), a soft deadline injects a wrap-up nudge, and a hard
 * deadline withdraws tools, logs `turn_hard_deadline`, and spawns a
 * depth-capped continuation job.
 *
 * Enabled via the `AURA_WDK_SLACK_RESPOND` env var or the
 * `wdk_slack_respond` setting (see src/pipeline/slack-workflow.ts). The
 * legacy in-process path in respond.ts remains the default.
 */
import type { ModelMessage } from "ai";
import type { FileContentPart } from "../src/lib/files.js";
import type { MessageContext } from "../src/pipeline/context.js";
import type { ToolCallRecord } from "../src/pipeline/respond.js";
import type { AnyChunk } from "../src/lib/slack-chunks.js";

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
  /** Slack refused an append with `stopped_by_user` — never post a fallback. */
  stoppedByUser?: boolean;
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
  /**
   * Wall-clock time elapsed since turnStartedAt, measured at the END of this
   * step. Durable (part of the step result), so the workflow's deadline
   * decisions replay deterministically.
   */
  elapsedMs: number;
}

/**
 * Turn wall-clock budget (issues #1318/#1320), recorded ONCE in a step so it
 * is workflow-durable: a replay after a SIGKILL returns the memoized values
 * instead of resetting the clock.
 */
export interface TurnClock {
  turnStartedAt: number;
  softDeadlineMs: number;
  hardDeadlineMs: number;
}

/** Per-step deadline state, derived from durable values in the workflow loop. */
export interface TurnDeadlineStepState {
  turnStartedAt: number;
  /** Elapsed at the end of the PREVIOUS step (0 for the first step). */
  elapsedMs: number;
  softDeadlineReached: boolean;
  hardDeadlineReached: boolean;
  /** Whether the hard-deadline continuation job was actually spawned. */
  continuationSpawned: boolean;
}

/**
 * Pure deadline evaluation for one loop iteration — extracted so the
 * workflow-loop behaviour is unit-testable without running the workflow.
 */
export function evaluateTurnDeadlines(
  elapsedMs: number,
  clock: Pick<TurnClock, "softDeadlineMs" | "hardDeadlineMs">,
): { softDeadlineReached: boolean; hardDeadlineReached: boolean } {
  return {
    softDeadlineReached: elapsedMs >= clock.softDeadlineMs,
    hardDeadlineReached: elapsedMs >= clock.hardDeadlineMs,
  };
}

const SLACK_STEP_LIMIT = 250;
const WRAP_UP_THRESHOLD = 200;
const STREAM_SPLIT_THRESHOLD = 9_000;
const STREAM_CONTINUATION_TOMBSTONE = "_(continuing in a new message...)_";
const EMPTY_COMPLETION_RELAUNCH_PROMPT =
  "(continue - you ended without responding. Summarize what you found.)";

// ── Steps ────────────────────────────────────────────────────────────────────

/**
 * Record the turn's wall-clock baseline + budgets (issue #1320). Runs as a
 * step so the values are durable: on replay the memoized result is returned,
 * NOT a fresh Date.now() — a per-step baseline would reset the budget every
 * time the workflow resumes.
 */
async function startTurnClock(): Promise<TurnClock> {
  "use step";
  const { resolveTurnDeadlines } = await import("../src/pipeline/turn-deadline.js");
  const { softDeadlineMs, hardDeadlineMs } = resolveTurnDeadlines("interactive");
  return { turnStartedAt: Date.now(), softDeadlineMs, hardDeadlineMs };
}

/**
 * Hard-deadline side effects (issue #1320), mirroring prepare-step.ts: log
 * the `turn_hard_deadline` error event and spawn the continuation job.
 * Returns whether the continuation was actually spawned (fail-soft), which
 * picks the WITH/WITHOUT-continuation hand-off message for the final step.
 */
async function handleTurnHardDeadline(
  input: SlackRespondWorkflowInput,
  elapsedMs: number,
  stepIndex: number,
  hardDeadlineMs: number,
): Promise<boolean> {
  "use step";
  const { logError } = await import("../src/lib/error-logger.js");
  const { spawnTurnContinuationJob } = await import("../src/pipeline/turn-deadline.js");
  const { logger } = await import("../src/lib/logger.js");

  logger.warn("slackRespondWorkflow: turn hard deadline tripped — withdrawing tools", {
    elapsedMs,
    hardDeadlineMs,
    stepIndex,
    channelId: input.channelId,
  });
  logError({
    errorName: "TurnHardDeadline",
    errorMessage: `Turn exceeded its hard wall-clock deadline (${hardDeadlineMs}ms); tools withdrawn to force a final message`,
    errorCode: "turn_hard_deadline",
    channelId: input.channelId,
    userId: input.userId,
    context: { elapsedMs, step: stepIndex, path: "interactive" },
  });

  return await spawnTurnContinuationJob({
    channelId: input.channelId,
    threadTs: input.threadTs,
    userId: input.userId,
    invocationId: input.invocationId,
    elapsedMs,
    step: stepIndex,
  });
}

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
  turn: TurnDeadlineStepState,
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
  const {
    getProviderThinkingOptions,
    WRAP_UP_MESSAGE,
    TURN_SOFT_DEADLINE_MESSAGE,
    TURN_HARD_DEADLINE_MESSAGE_WITH_CONTINUATION,
    TURN_HARD_DEADLINE_MESSAGE_WITHOUT_CONTINUATION,
  } = await import("../src/pipeline/prepare-step.js");
  const { isInvocationCurrent } = await import("../src/lib/invocation-lock.js");
  const { executionContext } = await import("../src/lib/tool.js");
  const { getSlackMeta } = await import("../src/lib/tool.js");
  const { pruneMessages } = await import("ai");
  const { logger } = await import("../src/lib/logger.js");

  const { logError } = await import("../src/lib/error-logger.js");

  const state: SlackStreamState = { ...streamState };
  // Set by streamText's onError — the real provider error for this step.
  let streamError: unknown = null;

  // ── Invocation staleness: one check per model call ──────────────────
  try {
    const current = await isInvocationCurrent(
      input.channelId,
      input.threadTs,
      input.invocationId,
    );
    if (!current) {
      return supersededResult(state, Date.now() - turn.turnStartedAt);
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
  // Past the hard turn deadline the tool set is EMPTY: the model cannot call
  // tools and must emit its final text in the remaining headroom (#1320).
  const scheduleContext = {
    userId: input.userId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    workspaceId: input.workspaceId,
    timezone: input.timezone,
  };
  const tools = turn.hardDeadlineReached
    ? ({} as Awaited<ReturnType<typeof createSlackTools>>)
    : await createSlackTools(
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

  // ── Dynamic-context nudges (mirrors prepare-step.ts) ────────────────
  let dynamicContext = input.dynamicContext;
  const appendNudge = (nudge: string) => {
    dynamicContext = dynamicContext ? `${dynamicContext}\n\n${nudge}` : nudge;
  };

  if (turn.hardDeadlineReached) {
    appendNudge(
      turn.continuationSpawned
        ? TURN_HARD_DEADLINE_MESSAGE_WITH_CONTINUATION
        : TURN_HARD_DEADLINE_MESSAGE_WITHOUT_CONTINUATION,
    );
  } else if (turn.softDeadlineReached) {
    logger.warn("slackRespondWorkflow: turn soft deadline reached — injecting wrap-up nudge", {
      elapsedMs: turn.elapsedMs,
      stepIndex,
      channelId: input.channelId,
    });
    appendNudge(
      TURN_SOFT_DEADLINE_MESSAGE.replace(
        "{elapsedSec}",
        String(Math.round(turn.elapsedMs / 1000)),
      ),
    );
  }

  if (stepIndex >= WRAP_UP_THRESHOLD) {
    appendNudge(
      WRAP_UP_MESSAGE
        .replace("{stepCount}", String(stepIndex))
        .replace("{limit}", String(SLACK_STEP_LIMIT)),
    );
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

  async function append(rawChunks: AnyChunk[]): Promise<void> {
    if (state.streamingFailed) return;
    if (!state.streamTs) await openStream();
    if (!state.streamTs) return;

    // Coerce every chunk to the exact server schema (or drop it) BEFORE the
    // call: one malformed element rejects the whole batch with
    // `invalid_arguments … [json-pointer:/chunks/N]` and the text in that
    // batch never reaches Slack (issue #1348).
    const { sanitizeChunks, markdownOnly, describeChunks, slackErrorDetail, isChunkSchemaRejection } =
      await import("../src/lib/slack-chunks.js");
    const { chunks, dropped } = sanitizeChunks(rawChunks);
    if (dropped.length > 0) {
      logger.warn("slackRespondWorkflow: dropped malformed chunk(s) before append", {
        channelId: input.channelId,
        dropped: dropped.map((d) => ({ reason: d.reason, chunk: describeChunks(d.chunk, 300) })),
      });
    }
    if (chunks.length === 0) return;

    try {
      await slackClient.apiCall("chat.appendStream", {
        channel: input.channelId,
        ts: state.streamTs,
        chunks,
      });
      state.charCount += JSON.stringify(chunks).length;
    } catch (error: any) {
      const code = error?.data?.error;
      if (code === "stopped_by_user") {
        // Stop button: Slack halted the stream and refuses appends. Terminal;
        // finalize must not re-post the buffered text.
        state.streamingFailed = true;
        state.stoppedByUser = true;
        logger.info("slackRespondWorkflow: append refused — stopped_by_user", {
          channelId: input.channelId,
        });
        return;
      }
      if (isChunkSchemaRejection(error)) {
        // Schema rejection is per-batch and atomic: retry the text-only
        // subset so the words still land, record the exact rejected payload
        // in error_events (this path used to be a warn-only black hole), and
        // keep streaming.
        const slackDetail = slackErrorDetail(error);
        const rejectedPayload = describeChunks(chunks);
        const textOnly = markdownOnly(chunks);
        let textRecovered = false;
        if (textOnly.length > 0 && textOnly.length < chunks.length) {
          try {
            await slackClient.apiCall("chat.appendStream", {
              channel: input.channelId,
              ts: state.streamTs,
              chunks: textOnly,
            });
            state.charCount += JSON.stringify(textOnly).length;
            textRecovered = true;
          } catch {
            // fall through — logged below
          }
        }
        logger.warn("slackRespondWorkflow: append rejected by Slack schema validation", {
          channelId: input.channelId,
          code,
          slackDetail,
          rejectedPayload,
          textRecovered,
        });
        const { logError } = await import("../src/lib/error-logger.js");
        logError({
          errorName: code === "invalid_chunks" ? "InvalidChunks" : "InvalidArguments",
          errorMessage: slackDetail
            ? `${code} on stream append: ${slackDetail}`
            : error?.message || `${code} on stream append`,
          errorCode: code || "invalid_arguments",
          channelId: input.channelId,
          userId: input.userId,
          context: {
            path: "slack-respond-workflow",
            chunkTypes: chunks.map((c) => c.type),
            rejectedPayload,
            textRecovered,
          },
        });
        return;
      }
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
          onError: ({ error }) => {
            // Keep the REAL provider error (context overflow, auth, 4xx…).
            // Without this the only thing that surfaces is the generic
            // `AI_NoOutputGeneratedError` from the awaited promises below,
            // which hides the cause and killed the whole run un-finalized.
            streamError = error;
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
          // Seen in production (2026-08-27): the gateway emits this event with
          // `id` rather than `toolCallId`; without the fallback the task_update
          // had no id and poisoned the whole append batch (issue #1348).
          const startId = (chunk as any).toolCallId ?? (chunk as any).id;
          if (typeof startId !== "string") break;
          await flushText(true);
          await append([
            {
              type: "task_update",
              id: startId,
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

    if (streamError) {
      const cause = streamError as { message?: string; name?: string; stack?: string };
      const message = cause?.message || String(streamError);
      logError({
        errorName: cause?.name && cause.name !== "Error" ? cause.name : "SlackWorkflowModelError",
        errorMessage: `Model call failed (${stepModelId}, step ${stepIndex}): ${message}`,
        errorCode: "workflow_model_error",
        channelId: input.channelId,
        userId: input.userId,
        context: {
          path: "slack-respond-workflow",
          stepIndex,
          modelId: stepModelId,
          messageCount: prunedMessages.length,
          textSoFar: text.length,
        },
        stackTrace: cause?.stack,
      });
      // Bubble a descriptive error: the workflow catches it, finalizes the
      // turn (closes the stream, posts a note, clears the session status)
      // instead of dying with the loading UX stuck on "processing".
      throw new Error(`Model call failed: ${message}`);
    }

    const [response, finishReason, usage] = await Promise.all([
      result.response,
      result.finishReason,
      result.usage,
    ]);

    const hadToolFailure = toolRecords.some((r) => r.is_error);

    return {
      superseded: false,
      elapsedMs: Date.now() - turn.turnStartedAt,
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

function supersededResult(
  state: SlackStreamState,
  elapsedMs: number,
): SlackAgentStepResult {
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
    elapsedMs,
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
  /** Set when outcome === "failed": the step error, shown to the user (truncated). */
  failureMessage?: string;
}): Promise<void> {
  "use step";
  const { WebClient } = await import("@slack/web-api");
  const { runBackgroundTasks } = await import("../src/pipeline/index.js");
  const { logger } = await import("../src/lib/logger.js");

  const { input, streamState, fullText, steps, stepModelIds, toolRecords, outcome, failureMessage } = params;
  const failureNote = outcome === "failed"
    ? `_Sorry — something went wrong and I had to stop${failureMessage ? `: ${failureMessage.slice(0, 300)}` : "."}_`
    : null;
  const { trySetAgentSessionStatus } = await import("../src/lib/slack-status.js");
  const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

  // ── Close / deliver ──────────────────────────────────────────────────
  try {
    if (streamState.streamTs && !streamState.streamingFailed) {
      const stopParams: Record<string, any> = {
        channel: input.channelId,
        ts: streamState.streamTs,
      };
      if (outcome === "superseded") {
        // "stopped" = the user pressed Stop (agent_session_stopped) — Slack
        // has already halted the stream, so both calls are best effort.
        const { getSupersedeReason, interruptionNote } = await import("../src/lib/invocation-lock.js");
        const note = interruptionNote(await getSupersedeReason(input.channelId, input.threadTs));
        await slackClient.apiCall("chat.appendStream", {
          channel: input.channelId,
          ts: streamState.streamTs,
          chunks: [{ type: "markdown_text", text: `\n\n${note}` }],
        }).catch(() => {});
      }
      if (failureNote) {
        await slackClient.apiCall("chat.appendStream", {
          channel: input.channelId,
          ts: streamState.streamTs,
          chunks: [{ type: "markdown_text", text: `\n\n${failureNote}` }],
        }).catch(() => {});
      }
      await slackClient.apiCall("chat.stopStream", stopParams);
    } else if (failureNote) {
      // Nothing was streamed (or streaming is unsupported here): tell the
      // user in a plain message rather than leaving the thread silent.
      await slackClient.chat.postMessage({
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: fullText.trim() ? `${fullText}\n\n${failureNote}` : failureNote,
      });
    } else if (streamState.stoppedByUser) {
      // Stop button — Slack already halted the bubble; do not re-post the
      // stopped answer. The `_[stopped]_` note comes from the superseded path.
      logger.info("slackRespondWorkflow: stopped by user — skipping fallback delivery", {
        channelId: input.channelId,
      });
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

  // ── End-of-turn: clear the loading UX ────────────────────────────────
  // The pipeline set the session status to "processing" before delegating to
  // this workflow, and Slack does not auto-clear it on message post — set
  // "active" here or the session spins until Slack's 1-hour timeout.
  // Superseded turns skip this: the superseding invocation has already set
  // its own "processing" and owns the status now. Soft-fail in the helper.
  if (outcome !== "superseded") {
    await trySetAgentSessionStatus({
      client: slackClient,
      channelId: input.channelId,
      threadTs: input.threadTs,
      status: "active",
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

  // ── Turn wall-clock budget (issue #1320) ────────────────────────────
  // The baseline + budgets are step-durable (survive replay). Deadline
  // decisions for step N use the elapsed time measured at the end of step
  // N-1 — a durable value — so replays take the same branches.
  const turnClock = await startTurnClock();
  let elapsedMs = 0;
  let hardDeadlineHandled = false;
  let continuationSpawned = false;

  try {
  for (let stepIndex = 0; stepIndex < SLACK_STEP_LIMIT; stepIndex++) {
    const { softDeadlineReached, hardDeadlineReached } = evaluateTurnDeadlines(
      elapsedMs,
      turnClock,
    );

    if (hardDeadlineReached && !hardDeadlineHandled) {
      hardDeadlineHandled = true;
      continuationSpawned = await handleTurnHardDeadline(
        input,
        elapsedMs,
        stepIndex,
        turnClock.hardDeadlineMs,
      );
    }

    const r = await runSlackAgentStep(input, messages, streamState, stepIndex, escalate, {
      turnStartedAt: turnClock.turnStartedAt,
      elapsedMs,
      softDeadlineReached,
      hardDeadlineReached,
      continuationSpawned,
    });

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
    elapsedMs = r.elapsedMs;
    if (r.hadToolFailure) failureCount++;
    if (!escalate && stepIndex > 15 && failureCount >= 3) {
      escalate = true;
    }

    // Past the hard deadline the step ran with no tools — its output is the
    // final message, regardless of finishReason.
    if (hardDeadlineReached) break;

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
  } catch (error: any) {
    // A step threw (model/provider error, tool crash, Slack outage…). Before
    // this catch existed the run died here as a Workflow FatalError: no
    // message, and — worse — the agent session stayed in "processing" so the
    // user saw "working" until Slack's 1-hour timeout. Always finalize.
    const failureMessage: string = error?.message || String(error);
    await finalizeSlackRespond({
      input,
      streamState,
      fullText,
      steps,
      stepModelIds,
      toolRecords,
      outcome: "failed",
      failureMessage,
    });
    return { interrupted: false, failed: true, text: fullText, error: failureMessage };
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

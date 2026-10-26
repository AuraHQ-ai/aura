import type { ModelMessage } from "ai";

/** Synthetic result when a tool call never produced output. */
export const INCOMPLETE_TOOL_CALL_ERROR = "Tool call did not complete";

/**
 * Denial shown to the model when a tool required user approval on a surface
 * that cannot collect it (Slack respond, jobs, headless).
 */
export const SURFACE_APPROVAL_DENIED_MESSAGE =
  "This tool requires approval, which is not available in this surface. Ask an admin to mark the server trusted or run the action manually.";

export type FilledToolResultKind = "approval" | "incomplete";

export interface FilledToolResult {
  toolCallId: string;
  toolName: string;
  input: unknown;
  kind: FilledToolResultKind;
}

export interface EnsureToolCallResultsResult {
  messages: Array<ModelMessage>;
  filled: FilledToolResult[];
}

interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  providerExecuted?: boolean;
  input?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isToolCallPart(part: unknown): part is ToolCallPart {
  return (
    isRecord(part) &&
    part.type === "tool-call" &&
    typeof part.toolCallId === "string" &&
    typeof part.toolName === "string"
  );
}

function isToolResultPart(part: unknown): part is { type: "tool-result"; toolCallId: string } {
  return isRecord(part) && part.type === "tool-result" && typeof part.toolCallId === "string";
}

function isProviderExecutedToolCall(part: ToolCallPart): boolean {
  return part.providerExecuted === true;
}

function contentParts(message: ModelMessage): unknown[] | null {
  return Array.isArray(message.content) ? (message.content as unknown[]) : null;
}

function collectResultIds(messages: Array<ModelMessage>): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const parts = contentParts(message);
    if (!parts) continue;
    for (const part of parts) {
      if (isToolResultPart(part)) ids.add(part.toolCallId);
    }
  }
  return ids;
}

function collectApprovalRequestCallIds(messages: Array<ModelMessage>): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const parts = contentParts(message);
    if (!parts) continue;
    for (const part of parts) {
      if (!isRecord(part) || part.type !== "tool-approval-request") continue;
      const toolCall = part.toolCall;
      if (isRecord(toolCall) && typeof toolCall.toolCallId === "string") {
        ids.add(toolCall.toolCallId);
      }
    }
  }
  return ids;
}

function syntheticResultPart(
  call: ToolCallPart,
  kind: FilledToolResultKind,
): Record<string, unknown> {
  const output =
    kind === "approval"
      ? { type: "execution-denied" as const, reason: SURFACE_APPROVAL_DENIED_MESSAGE }
      : {
          type: "error-json" as const,
          value: { ok: false, error: INCOMPLETE_TOOL_CALL_ERROR },
        };
  return {
    type: "tool-result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output,
  };
}

/**
 * Pair every client tool-call with a tool-result before the next provider call.
 *
 * Unresolved calls (needsApproval with no response, a crashed execute, a
 * dropped stream chunk, …) otherwise throw AI_MissingToolResultsError on the
 * follow-up model step. Provider-executed calls are left alone — the provider
 * owns their lifecycle.
 */
export function ensureToolCallResults(messages: Array<ModelMessage>): EnsureToolCallResultsResult {
  const resultIds = collectResultIds(messages);
  const approvalCallIds = collectApprovalRequestCallIds(messages);
  const filled: FilledToolResult[] = [];

  const result: Array<ModelMessage> = [];
  let skipNext = false;

  for (let i = 0; i < messages.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    const message = messages[i]!;
    const parts = contentParts(message);
    const missing =
      message.role === "assistant" && parts
        ? parts.filter(isToolCallPart).filter((part) => {
            if (isProviderExecutedToolCall(part)) return false;
            return !resultIds.has(part.toolCallId);
          })
        : [];

    if (missing.length === 0) {
      result.push(message);
      continue;
    }

    const syntheticParts = missing.map((call) => {
      const kind: FilledToolResultKind = approvalCallIds.has(call.toolCallId)
        ? "approval"
        : "incomplete";
      filled.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        kind,
      });
      resultIds.add(call.toolCallId);
      return syntheticResultPart(call, kind);
    });

    result.push(message);
    const next = messages[i + 1];
    if (next?.role === "tool" && Array.isArray(next.content)) {
      result.push({
        ...next,
        content: [...next.content, ...syntheticParts],
      } as ModelMessage);
      skipNext = true;
    } else {
      result.push({ role: "tool", content: syntheticParts } as ModelMessage);
    }
  }

  if (filled.length === 0) {
    return { messages, filled };
  }
  return { messages: result, filled };
}

/** True when a tool output represents a failure the model (and Slack cards) should treat as an error. */
export function isFailedToolOutput(output: unknown): boolean {
  if (!isRecord(output)) return false;
  if (output.ok === false) return true;
  if (typeof output.error === "string" && output.error.length > 0) return true;
  return (
    output.type === "execution-denied" ||
    output.type === "error-json" ||
    output.type === "error-text"
  );
}

function toolNeedsUserApproval(def: unknown): boolean {
  if (!isRecord(def)) return false;
  return def.needsApproval === true;
}

/**
 * `toolApproval` for surfaces that cannot collect a human decision (Slack
 * respond, jobs, headless, subagents). User-defined `toolApproval` takes
 * precedence over tool-level `needsApproval`, so this auto-denies write-like
 * MCP tools in the same generation instead of leaving a dangling tool-call.
 */
export function createUnavailableSurfaceToolApproval(reason = SURFACE_APPROVAL_DENIED_MESSAGE) {
  return ({
    toolCall,
    tools,
  }: {
    toolCall: { toolName: string; input?: unknown };
    tools?: Record<string, unknown>;
  }) => {
    if (!toolNeedsUserApproval(tools?.[toolCall.toolName])) return undefined;
    void import("../lib/mcp-runtime.js")
      .then(({ auditDeniedMcpToolCall }) =>
        auditDeniedMcpToolCall(toolCall.toolName, toolCall.input, reason),
      )
      .catch(() => {});
    return { type: "denied" as const, reason };
  };
}

export function auditFilledApprovalDenials(filled: EnsureToolCallResultsResult): void {
  const denied = filled.filled.filter((item) => item.kind === "approval");
  if (denied.length === 0) return;
  void import("../lib/mcp-runtime.js")
    .then(({ auditDeniedMcpToolCall }) =>
      Promise.all(
        denied.map((item) =>
          auditDeniedMcpToolCall(item.toolName, item.input, SURFACE_APPROVAL_DENIED_MESSAGE),
        ),
      ),
    )
    .catch(() => {});
}

/**
 * Fill unpaired tool-calls and audit approval denials. Used at every
 * message-assembly boundary before a follow-up model call.
 */
export function applyMissingToolResultGuard(
  messages: Array<ModelMessage>,
): EnsureToolCallResultsResult {
  const filled = ensureToolCallResults(messages);
  auditFilledApprovalDenials(filled);
  return filled;
}

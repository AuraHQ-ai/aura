import type { UIMessage } from "ai";

/**
 * Append the in-flight turn's user bubble to a restored transcript.
 *
 * Conversation traces are persisted when a turn COMPLETES, so while a run is
 * generating, the persisted history doesn't contain the user message that
 * started it (and the run's stream only replays assistant chunks). Sessions
 * attaching mid-generation would render the assistant answering nothing.
 *
 * The pending text is recorded on the run row at start time; this merges it
 * in unless the transcript already ends with that exact user message (the
 * originating tab, which appended it locally before sending).
 */
export function appendPendingUserMessage(
  messages: UIMessage[],
  pendingUserMessage: string | null | undefined,
  runId: string,
): UIMessage[] {
  if (!pendingUserMessage) return messages;

  const last = messages[messages.length - 1];
  if (last?.role === "user") {
    const lastText = (last.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    if (lastText === pendingUserMessage) return messages;
  }

  return [
    ...messages,
    {
      id: `pending-user-${runId}`,
      role: "user",
      parts: [{ type: "text", text: pendingUserMessage }],
    } as UIMessage,
  ];
}

/**
 * Anthropic rejects assistant messages where tool_use blocks are followed by
 * text in the same message, because the next message must immediately start
 * with tool_result. Reorder parts so text comes before tool-invocations.
 * Also strip reasoning parts from non-final messages (they require signed
 * provider metadata that we don't persist).
 */
export function sanitizeAssistantPartOrder(messages: UIMessage[]): UIMessage[] {
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  return messages.map((msg, index) => {
    if (msg.role !== "assistant" || !msg.parts) return msg;
    const isLastAssistantMessage = index === lastAssistantIndex;
    const rawParts = msg.parts as any[];
    const hasToolParts = rawParts.some(
      (part) =>
        part.type === "dynamic-tool" ||
        (typeof part.type === "string" && part.type.startsWith("tool-")),
    );

    if (!hasToolParts) {
      const filteredParts = rawParts.filter((part) => {
        if (part.type === "step-start") return false;
        if (part.type === "reasoning" && !isLastAssistantMessage) return false;
        return true;
      });
      return filteredParts.length === rawParts.length
        ? msg
        : ({ ...msg, parts: filteredParts } as UIMessage);
    }

    const textParts: any[] = [];
    const toolParts: any[] = [];
    const otherParts: any[] = [];

    for (const part of rawParts) {
      if (part.type === "text") textParts.push(part);
      else if (part.type === "dynamic-tool" || (typeof part.type === "string" && part.type.startsWith("tool-")))
        toolParts.push(part);
      else if (part.type === "reasoning") {
        // Preserve reasoning on the final assistant message so the dashboard can render it.
        if (isLastAssistantMessage) otherParts.push(part);
      } else if (part.type === "step-start") {
        // drop: step-start is UI-only
      } else otherParts.push(part);
    }

    return { ...msg, parts: [...otherParts, ...textParts, ...toolParts] } as UIMessage;
  });
}

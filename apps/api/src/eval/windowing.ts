/**
 * Sliding-window construction for the eval response judge (Machine A).
 *
 * The scoring unit is the atomic assistant response (one conversation_messages
 * row with a text part); the context unit is a dumb sliding window: each
 * window owns a `stride` of turns and sees a few `lead` turns before (the
 * antecedent ask) and `trail` turns after (did an honest hedge get resolved?).
 * There is deliberately NO topic/time segmenter here — the judge's
 * `serving_intent` output attributes each response to the nearest open user
 * ask, which makes topic switches need zero detection.
 */

export interface EvalTurn {
  role: "user" | "assistant";
  /** conversation_messages.id of the message this turn came from. */
  messageId: string;
  /** Primary text part judged (assistant turns only) — the [R:...] marker id. */
  partId: string | null;
  /** conversation_traces.id — attribution grain. */
  traceId: string;
  text: string;
  userId: string | null;
  createdAt: Date | null;
  /** Tool names invoked while producing this response (context for the judge). */
  toolNames: string[];
}

export interface EvalWindow {
  /** All turns the judge sees (context). */
  turns: EvalTurn[];
  /** part_ids of the assistant turns whose verdicts this window owns. */
  ownedPartIds: string[];
}

/** Turns committed (owned) per window step. */
export const WINDOW_STRIDE = 14;
/** Leading context turns prepended so a boundary response sees its antecedent. */
export const WINDOW_LEAD = 3;
/** Trailing context turns appended so `resolved_in_window` can see a hedge
 * resolve a few turns later — even for responses at the end of a commit
 * region. lead + stride + trail ≈ the 20-turn Sonnet batch from the spec. */
export const WINDOW_TRAIL = 3;

/** Minimal shapes needed from the conversation_* tables (kept structural so
 * tests don't need full Drizzle row objects). */
export interface TurnSourceTrace {
  id: string;
  threadTs: string | null;
  userId: string | null;
  createdAt: Date;
}

export interface TurnSourceMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string | null;
  orderIndex: number;
  createdAt: Date | null;
}

export interface TurnSourcePart {
  id: string;
  messageId: string;
  type: string;
  orderIndex: number;
  textValue: string | null;
  toolName: string | null;
}

/**
 * Flatten a thread (one or more traces, each trace = one Aura invocation) into
 * an ordered list of user/assistant turns.
 *
 * - Each trace contributes its user message(s) and every assistant message
 *   that carries a non-empty text part. Tool-only assistant steps contribute
 *   their tool names to the NEXT text-bearing assistant turn in the same
 *   trace, so the judge sees what tools ran without judging relay steps.
 * - System messages never become turns.
 */
export function buildTurns(
  traces: TurnSourceTrace[],
  messages: TurnSourceMessage[],
  parts: TurnSourcePart[],
): EvalTurn[] {
  const orderedTraces = [...traces].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const messagesByTrace = new Map<string, TurnSourceMessage[]>();
  for (const msg of messages) {
    const list = messagesByTrace.get(msg.conversationId) ?? [];
    list.push(msg);
    messagesByTrace.set(msg.conversationId, list);
  }
  const partsByMessage = new Map<string, TurnSourcePart[]>();
  for (const part of parts) {
    const list = partsByMessage.get(part.messageId) ?? [];
    list.push(part);
    partsByMessage.set(part.messageId, list);
  }

  const turns: EvalTurn[] = [];

  for (const trace of orderedTraces) {
    const traceMessages = (messagesByTrace.get(trace.id) ?? []).sort(
      (a, b) => a.orderIndex - b.orderIndex,
    );
    let pendingToolNames: string[] = [];

    for (const msg of traceMessages) {
      const msgParts = (partsByMessage.get(msg.id) ?? []).sort(
        (a, b) => a.orderIndex - b.orderIndex,
      );

      if (msg.role === "user") {
        const text =
          msg.content?.trim() ||
          msgParts
            .filter((p) => p.type === "text" && p.textValue?.trim())
            .map((p) => p.textValue!.trim())
            .join("\n\n");
        if (!text) continue;
        turns.push({
          role: "user",
          messageId: msg.id,
          partId: null,
          traceId: trace.id,
          text,
          userId: trace.userId,
          createdAt: msg.createdAt,
          toolNames: [],
        });
        continue;
      }

      if (msg.role !== "assistant") continue;

      const toolNames = msgParts
        .filter((p) => p.type === "tool-invocation" && p.toolName)
        .map((p) => p.toolName!);
      const textParts = msgParts.filter(
        (p) => p.type === "text" && p.textValue?.trim(),
      );

      if (textParts.length === 0) {
        // Tool-only relay step: carry its tool names to the next response.
        pendingToolNames.push(...toolNames);
        continue;
      }

      turns.push({
        role: "assistant",
        messageId: msg.id,
        partId: textParts[0].id,
        traceId: trace.id,
        text: textParts.map((p) => p.textValue!.trim()).join("\n\n"),
        userId: null,
        createdAt: msg.createdAt,
        toolNames: [...pendingToolNames, ...toolNames],
      });
      pendingToolNames = [];
    }
  }

  return turns;
}

export interface WindowOptions {
  /** Turns committed (owned) per window step. */
  stride?: number;
  /** Leading context turns prepended to each window slice. */
  lead?: number;
  /** Trailing context turns appended to each window slice. */
  trail?: number;
}

/**
 * Tile the turn list into consecutive commit regions of `stride` turns; each
 * window's context slice extends `lead` turns before and `trail` turns after
 * its region, so a boundary response still sees both its antecedent (what was
 * asked) and its resolution (`resolved_in_window`). Ownership is EXCLUSIVE:
 * every assistant turn is owned by exactly one window — the lead/trail turns
 * reappear elsewhere only as context, never as scoring targets, so verdicts
 * stay atomic.
 */
export function buildWindows(
  turns: EvalTurn[],
  opts: WindowOptions = {},
): EvalWindow[] {
  const stride = Math.max(1, opts.stride ?? WINDOW_STRIDE);
  const lead = Math.max(0, opts.lead ?? WINDOW_LEAD);
  const trail = Math.max(0, opts.trail ?? WINDOW_TRAIL);
  const windows: EvalWindow[] = [];

  for (let start = 0; start < turns.length; start += stride) {
    const commitEnd = Math.min(start + stride, turns.length);
    const ownedPartIds = turns
      .slice(start, commitEnd)
      .filter((t) => t.role === "assistant" && t.partId)
      .map((t) => t.partId!);
    if (ownedPartIds.length === 0) continue;

    const sliceStart = Math.max(0, start - lead);
    const sliceEnd = Math.min(turns.length, commitEnd + trail);
    windows.push({ turns: turns.slice(sliceStart, sliceEnd), ownedPartIds });
  }

  return windows;
}

const MAX_TURN_CHARS = 4_000;

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n... [truncated ${text.length - maxChars} chars] ...\n${text.slice(-half)}`;
}

/**
 * Render a window as a transcript for the judge prompt. Each assistant turn is
 * injected with its conversation_parts id as a stable `[R:<part_id>]` marker —
 * the judge MUST echo these ids back, and verdicts are mapped by id, never by
 * array position.
 */
export function renderWindowTranscript(
  window: EvalWindow,
  maxTurnChars = MAX_TURN_CHARS,
): string {
  const ownedSet = new Set(window.ownedPartIds);
  const lines: string[] = [];

  for (const turn of window.turns) {
    const ts = turn.createdAt ? turn.createdAt.toISOString() : "unknown time";
    if (turn.role === "user") {
      const who = turn.userId ? `USER ${turn.userId}` : "USER";
      lines.push(`${who} @ ${ts}:\n${truncateMiddle(turn.text, maxTurnChars)}`);
    } else {
      const tools =
        turn.toolNames.length > 0
          ? ` (tools used: ${[...new Set(turn.toolNames)].join(", ")})`
          : "";
      // Only scoring targets get a marker; context-only turns carry no id so
      // the judge is never tempted to emit a verdict for them.
      const marker =
        turn.partId && ownedSet.has(turn.partId)
          ? `[R:${turn.partId}] AURA`
          : "AURA (context only — do not score)";
      lines.push(
        `${marker} @ ${ts}${tools}:\n${truncateMiddle(turn.text, maxTurnChars)}`,
      );
    }
  }

  return lines.join("\n\n");
}

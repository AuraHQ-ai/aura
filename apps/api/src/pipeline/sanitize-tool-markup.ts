import type { ModelMessage } from "ai";

// ── Raw tool-call markup sanitization (issue #1515) ──────────────────────────
// zai/glm-5.3-flash (and similar ChatML-template models) sometimes emit tool
// calls as literal XML in assistant *text* instead of the API's native
// tool-call channel:
//   <tool_call>run_command<arg_key>command</arg_key><arg_value>cat ...
// That markup is then posted verbatim to Slack, stored in `messages`, and in
// the worst case the blob is parsed as a tool name → AI_NoSuchToolError.
//
// This module is a pure transform used at two boundaries:
//   1. Delivery (slack-chunks / streaming buffer): strip markup from text
//      before it reaches Slack. Issue #1524 also strips bare registry tool
//      names and `_suffix` fragments (`_history`) that survive the XML pass.
//   2. Model (prepareStep): drop markup from replayed assistant text, and
//      repairToolCall: salvage a native tool-call whose *name* is the XML
//      blob, or refuse to execute it as a tool name.
// Callers decide how to log. Same contract as sanitize-tool-ids.ts.

const SAMPLE_MAX = 240;

/** GLM ChatML / Hermes / Anthropic-XML function-call openers. */
const MARKUP_OPENER_RE =
  /<(?:tool_call\b|invoke\b|function\s*=|arg_key\b|arg_value\b|parameter\b)/i;

/** Incomplete tag suffix we must not flush mid-stream (`<tool`, `<arg_ke`, …). */
const INCOMPLETE_TAG_AT_END_RE = /<\/?[A-Za-z_]{0,24}$/;

const CLOSED_TOOL_CALL_RE = /<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi;
const CLOSED_INVOKE_RE = /<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi;
const CLOSED_FUNCTION_RE = /<function\s*=[^>]*>[\s\S]*?<\/function>/gi;
const UNCLOSED_TOOL_CALL_RE = /<tool_call\b[^>]*>[\s\S]*$/i;
const UNCLOSED_INVOKE_RE = /<invoke\b[^>]*>[\s\S]*$/i;
const UNCLOSED_FUNCTION_RE = /<function\s*=[^>]*>[\s\S]*$/i;
const LEFTOVER_ARG_TAGS_RE =
  /<\/?(?:arg_key|arg_value|parameter)\b[^>]*>/gi;

const TOOL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/;

/** Shortest underscore-suffix we treat as a leaked fragment (`_url`, `_history`). */
const MIN_SUFFIX_LEN = 4;

/**
 * Trailing token that might still grow into a known tool name / `_suffix`
 * fragment on the next text-delta. Requires an underscore so ordinary words
 * like "read" are not held back.
 */
const TRAILING_TOOL_TOKEN_RE =
  /(_[A-Za-z0-9_]*|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*)$/;

export interface StripToolCallMarkupResult {
  text: string;
  stripped: boolean;
  samples: string[];
}

export interface SanitizeAssistantToolMarkupResult {
  messages: Array<ModelMessage>;
  changed: boolean;
  strippedTextCount: number;
  droppedLeakedToolCallIds: string[];
  samples: string[];
}

export interface SalvagedToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolMarkupBuffer {
  push(delta: string): string;
  flush(): string;
  didLeak(): boolean;
  samples(): string[];
}

function truncateSample(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SAMPLE_MAX) return collapsed;
  return `${collapsed.slice(0, SAMPLE_MAX)}…(+${collapsed.length - SAMPLE_MAX}c)`;
}

function collectSamples(text: string, regex: RegExp, into: string[]): void {
  regex.lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    if (match[0]) into.push(truncateSample(match[0]));
  }
}

/** True when `text` contains ChatML-style tool-call XML. */
export function containsToolCallMarkup(text: string): boolean {
  if (!text) return false;
  return MARKUP_OPENER_RE.test(text) || /<\/(?:tool_call|invoke|function|arg_key|arg_value)\b/i.test(text);
}

/**
 * A tool name that came from leaked markup rather than the API tool-call
 * channel. Native names are `[a-zA-Z_][a-zA-Z0-9_]*`; XML blobs always
 * contain `<` / `>` (issue #1515: the whole `<tool_call>run_command…` string
 * was used as the tool name).
 */
export function isLeakedMarkupToolName(toolName: string): boolean {
  if (!toolName) return false;
  return /[<>]/.test(toolName) || containsToolCallMarkup(toolName);
}

function isKnownTool(
  tools: Record<string, unknown> | null | undefined,
  name: string,
): boolean {
  return Boolean(
    tools &&
      TOOL_NAME_RE.test(name) &&
      !isLeakedMarkupToolName(name) &&
      Object.prototype.hasOwnProperty.call(tools, name),
  );
}

function indexOfOpener(text: string): number {
  const match = MARKUP_OPENER_RE.exec(text);
  MARKUP_OPENER_RE.lastIndex = 0;
  return match?.index ?? -1;
}

function matchingCloseEnd(rest: string): number | null {
  const fn = /^<function\s*=/i.test(rest);
  if (fn) {
    const close = rest.search(/<\/function>/i);
    return close >= 0 ? close + "</function>".length : null;
  }
  const opener = rest.match(/^<(tool_call|invoke|arg_key|arg_value|parameter)\b/i);
  if (!opener) return null;
  const name = opener[1].toLowerCase();
  // Interior arg tags are fragments of a `<tool_call>` block that started in
  // a previous delta; wait for the outer closer when present.
  const closeTag =
    name === "arg_key" || name === "arg_value" || name === "parameter"
      ? "</tool_call>"
      : `</${name}>`;
  const close = rest.search(new RegExp(closeTag.replace("/", "\\/"), "i"));
  if (close >= 0) return close + closeTag.length;
  return null;
}

/**
 * Strip ChatML-style tool-call XML from assistant text. Closed blocks are
 * removed; an unclosed opener eats the rest of the string (the observed
 * GLM leak is often unterminated). Surrounding prose is preserved.
 */
export function stripToolCallMarkup(text: string): StripToolCallMarkupResult {
  if (!text || !containsToolCallMarkup(text)) {
    return { text, stripped: false, samples: [] };
  }

  const samples: string[] = [];
  collectSamples(text, CLOSED_TOOL_CALL_RE, samples);
  collectSamples(text, CLOSED_INVOKE_RE, samples);
  collectSamples(text, CLOSED_FUNCTION_RE, samples);

  let out = text
    .replace(CLOSED_TOOL_CALL_RE, "")
    .replace(CLOSED_INVOKE_RE, "")
    .replace(CLOSED_FUNCTION_RE, "");

  const unclosed =
    UNCLOSED_TOOL_CALL_RE.exec(out) ??
    UNCLOSED_INVOKE_RE.exec(out) ??
    UNCLOSED_FUNCTION_RE.exec(out);
  UNCLOSED_TOOL_CALL_RE.lastIndex = 0;
  UNCLOSED_INVOKE_RE.lastIndex = 0;
  UNCLOSED_FUNCTION_RE.lastIndex = 0;
  if (unclosed && unclosed.index != null) {
    samples.push(truncateSample(unclosed[0]));
    out = out.slice(0, unclosed.index);
  }

  if (/<(?:arg_key|arg_value|parameter)\b/i.test(out)) {
    out = out.replace(/<arg_key\b[\s\S]*?(?:<\/arg_value>|$)/gi, "");
    out = out.replace(/<arg_value\b[\s\S]*?(?:<\/arg_value>|$)/gi, "");
    out = out.replace(/<parameter\b[\s\S]*?(?:<\/parameter>|$)/gi, "");
    out = out.replace(LEFTOVER_ARG_TAGS_RE, "");
  }
  LEFTOVER_ARG_TAGS_RE.lastIndex = 0;

  // Collapse the holes left by removed blocks, but keep paragraph breaks.
  out = out.replace(/[^\S\n]*\n[^\S\n]*\n+/g, "\n\n").replace(/[^\S\n]{2,}/g, " ");

  return { text: out, stripped: true, samples };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collapseStripHoles(text: string): string {
  return text.replace(/[^\S\n]*\n[^\S\n]*\n+/g, "\n\n").replace(/[^\S\n]{2,}/g, " ");
}

/**
 * Tokens the Slack-boundary stripper should neutralize: each known tool
 * registry name, plus every underscore-suffixed fragment of those names
 * (issue #1524: `_history` leaked after the ChatML stripper ate the rest of
 * `read_channel_history`).
 */
export function collectToolNameLeakTokens(
  toolNames: Iterable<string> | null | undefined,
): string[] {
  const tokens = new Set<string>();
  if (!toolNames) return [];
  for (const name of toolNames) {
    if (!name || !TOOL_NAME_RE.test(name) || isLeakedMarkupToolName(name)) continue;
    tokens.add(name);
    let i = name.indexOf("_");
    while (i >= 0) {
      const suffix = name.slice(i);
      if (suffix.length >= MIN_SUFFIX_LEN) tokens.add(suffix);
      i = name.indexOf("_", i + 1);
    }
  }
  return [...tokens].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function toolNameLeakRegex(tokens: string[]): RegExp | null {
  if (tokens.length === 0) return null;
  return new RegExp(
    `(?<![A-Za-z0-9])(?:${tokens.map(escapeRegex).join("|")})(?![A-Za-z0-9_])`,
    "g",
  );
}

/**
 * Strip bare known-tool-name tokens and their `_suffix` fragments from
 * assistant text so leftovers like `_history` never reach Slack.
 *
 * Does not touch ordinary prose ("channel history") — only identifier-bounded
 * matches against the provided registry names.
 */
export function stripLeakedToolNameFragments(
  text: string,
  toolNames?: Iterable<string> | null,
): StripToolCallMarkupResult {
  if (!text) return { text, stripped: false, samples: [] };
  const tokens = collectToolNameLeakTokens(toolNames);
  const regex = toolNameLeakRegex(tokens);
  if (!regex) return { text, stripped: false, samples: [] };

  const samples: string[] = [];
  const out = text.replace(regex, (match) => {
    samples.push(truncateSample(match));
    return "";
  });
  if (samples.length === 0) return { text, stripped: false, samples: [] };

  return { text: collapseStripHoles(out), stripped: true, samples };
}

/** XML strip + bare tool-name fragment strip (Slack delivery). */
export function sanitizeAssistantSlackText(
  text: string,
  toolNames?: Iterable<string> | null,
): StripToolCallMarkupResult {
  const markup = stripToolCallMarkup(text);
  const fragments = stripLeakedToolNameFragments(markup.text, toolNames);
  if (!markup.stripped && !fragments.stripped) {
    return { text, stripped: false, samples: [] };
  }
  return {
    text: fragments.text,
    stripped: true,
    samples: [...markup.samples, ...fragments.samples],
  };
}

function holdIncompleteToolNameToken(
  text: string,
  tokens: string[],
): { emit: string; hold: string } {
  if (!text || tokens.length === 0) return { emit: text, hold: "" };
  const match = TRAILING_TOOL_TOKEN_RE.exec(text);
  TRAILING_TOOL_TOKEN_RE.lastIndex = 0;
  if (!match?.[1] || match.index == null) return { emit: text, hold: "" };
  const partial = match[1];
  const isStrictPrefix = tokens.some((token) => token.startsWith(partial) && token !== partial);
  if (!isStrictPrefix) return { emit: text, hold: "" };
  return { emit: text.slice(0, match.index), hold: partial };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function coerceArgValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed !== "" && Number.isFinite(Number(trimmed)) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  try {
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      return JSON.parse(trimmed);
    }
  } catch {
    // fall through — keep as string
  }
  return decodeXmlEntities(raw);
}

function parseArgKeyValuePairs(body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const pairRe =
    /<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)(?:<\/arg_value>|$)/gi;
  for (const match of body.matchAll(pairRe)) {
    const key = match[1]?.trim();
    if (key) input[key] = coerceArgValue(match[2] ?? "");
  }
  const paramRe =
    /<parameter(?:\s+name\s*=\s*["']([^"']+)["']|\s*=\s*([^>\s]+))\s*>([\s\S]*?)(?:<\/parameter>|$)/gi;
  for (const match of body.matchAll(paramRe)) {
    const key = (match[1] || match[2] || "").trim();
    if (key) input[key] = coerceArgValue(match[3] ?? "");
  }
  return input;
}

function parseJsonToolPayload(body: string): SalvagedToolCall | null {
  const trimmed = body.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as {
      name?: unknown;
      tool?: unknown;
      arguments?: unknown;
      parameters?: unknown;
      input?: unknown;
    };
    const name = parsed.name ?? parsed.tool;
    if (typeof name !== "string" || !TOOL_NAME_RE.test(name)) return null;
    const args = parsed.arguments ?? parsed.parameters ?? parsed.input ?? {};
    const input =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : { value: args };
    return { toolName: name, input };
  } catch {
    return null;
  }
}

function parseOneToolCallBlock(block: string): SalvagedToolCall | null {
  const inner = block
    .replace(/^<(?:tool_call|invoke)\b[^>]*>/i, "")
    .replace(/^<function\s*=[^>]*>/i, "")
    .replace(/<\/(?:tool_call|invoke|function)>\s*$/i, "");

  const json = parseJsonToolPayload(inner);
  if (json) return json;

  const invokeName = block.match(/<invoke\b[^>]*\bname\s*=\s*["']([^"']+)["']/i)?.[1];
  const functionName = block.match(/<function\s*=\s*([^>\s]+)/i)?.[1];
  const glmName = inner.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<|$)/)?.[1];
  const toolName = (invokeName || functionName || glmName || "").trim();
  if (!TOOL_NAME_RE.test(toolName)) return null;

  return { toolName, input: parseArgKeyValuePairs(inner) };
}

/**
 * Best-effort parse of leaked ChatML tool XML into `{ toolName, input }`.
 * Returns only candidates whose names look like real tool identifiers —
 * never the raw XML blob.
 */
export function parseLeakedToolCalls(text: string): SalvagedToolCall[] {
  if (!text) return [];
  const blocks: string[] = [];
  for (const re of [CLOSED_TOOL_CALL_RE, CLOSED_INVOKE_RE, CLOSED_FUNCTION_RE]) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      if (match[0]) blocks.push(match[0]);
    }
  }
  const unclosed =
    UNCLOSED_TOOL_CALL_RE.exec(text) ??
    UNCLOSED_INVOKE_RE.exec(text) ??
    UNCLOSED_FUNCTION_RE.exec(text);
  UNCLOSED_TOOL_CALL_RE.lastIndex = 0;
  UNCLOSED_INVOKE_RE.lastIndex = 0;
  UNCLOSED_FUNCTION_RE.lastIndex = 0;
  if (unclosed?.[0] && !blocks.some((b) => b === unclosed[0] || unclosed[0].startsWith(b))) {
    blocks.push(unclosed[0]);
  }
  if (blocks.length === 0 && containsToolCallMarkup(text)) {
    blocks.push(text);
  }

  const out: SalvagedToolCall[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const parsed = parseOneToolCallBlock(block);
    if (!parsed) continue;
    const key = `${parsed.toolName}:${JSON.stringify(parsed.input)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

function isToolCallPart(
  part: unknown,
): part is { type: "tool-call"; toolCallId: string; toolName: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "tool-call" &&
    typeof (part as { toolCallId?: unknown }).toolCallId === "string" &&
    typeof (part as { toolName?: unknown }).toolName === "string"
  );
}

function isToolResultPart(
  part: unknown,
): part is { type: "tool-result"; toolCallId: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "tool-result" &&
    typeof (part as { toolCallId?: unknown }).toolCallId === "string"
  );
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}

/**
 * Drop leaked ChatML markup from assistant text in the in-flight message
 * array, and drop tool-call parts whose *name* is the XML blob (so they can
 * never be replayed as a tool). Matching tool_result parts are dropped so
 * the pair stays consistent for sanitizeToolCallIds.
 *
 * Pure: original array is returned unchanged (same reference) when clean.
 */
export function sanitizeAssistantToolMarkup(
  messages: Array<ModelMessage>,
): SanitizeAssistantToolMarkupResult {
  const leakedCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as unknown[]) {
      if (isToolCallPart(part) && isLeakedMarkupToolName(part.toolName)) {
        leakedCallIds.add(part.toolCallId);
      }
    }
  }

  const samples: string[] = [];
  const droppedLeakedToolCallIds: string[] = [];
  let strippedTextCount = 0;
  let changed = false;
  const result: Array<ModelMessage> = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      if (message.role !== "assistant") {
        result.push(message);
        continue;
      }
      const stripped = stripToolCallMarkup(message.content);
      if (!stripped.stripped) {
        result.push(message);
        continue;
      }
      changed = true;
      strippedTextCount++;
      samples.push(...stripped.samples);
      if (!stripped.text.trim()) continue;
      result.push({ ...message, content: stripped.text } as ModelMessage);
      continue;
    }

    if (!Array.isArray(message.content)) {
      result.push(message);
      continue;
    }

    if (message.role !== "assistant" && message.role !== "tool") {
      result.push(message);
      continue;
    }

    let messageChanged = false;
    const newContent: unknown[] = [];
    for (const part of message.content as unknown[]) {
      if (message.role === "assistant" && isTextPart(part)) {
        const stripped = stripToolCallMarkup(part.text);
        if (!stripped.stripped) {
          newContent.push(part);
          continue;
        }
        messageChanged = true;
        strippedTextCount++;
        samples.push(...stripped.samples);
        if (!stripped.text.trim()) continue;
        newContent.push({ ...part, text: stripped.text });
        continue;
      }

      if (message.role === "assistant" && isToolCallPart(part) && isLeakedMarkupToolName(part.toolName)) {
        messageChanged = true;
        droppedLeakedToolCallIds.push(part.toolCallId);
        samples.push(truncateSample(part.toolName));
        continue;
      }

      if (
        message.role === "tool" &&
        isToolResultPart(part) &&
        leakedCallIds.has(part.toolCallId)
      ) {
        messageChanged = true;
        continue;
      }

      newContent.push(part);
    }

    if (!messageChanged) {
      result.push(message);
      continue;
    }

    changed = true;
    if (newContent.length === 0) continue;
    result.push({ ...message, content: newContent } as ModelMessage);
  }

  if (!changed) {
    return {
      messages,
      changed: false,
      strippedTextCount: 0,
      droppedLeakedToolCallIds: [],
      samples: [],
    };
  }

  return {
    messages: result,
    changed: true,
    strippedTextCount,
    droppedLeakedToolCallIds,
    samples,
  };
}

function toolCallInputToString(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

/**
 * Repair a native tool-call whose name is leaked ChatML XML (issue #1515).
 *
 * Salvage is allowed only when the XML parses to a real identifier that
 * exists on the provided `tools` map — the name then comes from the parse
 * of an API-channel tool-call, never from executing the XML blob itself.
 * If salvage fails, returns null so the SDK marks the call invalid and
 * does not execute it (AI_NoSuchToolError is not rethrown as a crash).
 *
 * Genuine unknown tools (typos, missing names) also return null and are
 * left to the SDK's existing invalid-tool path.
 */
export function salvageLeakedToolCall(
  toolCall: { toolCallId?: string; toolName?: string; input?: unknown },
  tools?: Record<string, unknown> | null,
): {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: string;
} | null {
  const toolName = toolCall.toolName ?? "";
  const toolCallId = toolCall.toolCallId ?? "";
  if (!toolCallId || !isLeakedMarkupToolName(toolName)) return null;

  const blob = `${toolName}\n${toolCallInputToString(toolCall.input)}`;
  const parsed = parseLeakedToolCalls(blob);
  const known = parsed.find((call) => isKnownTool(tools, call.toolName));
  if (!known) return null;

  return {
    type: "tool-call",
    toolCallId,
    toolName: known.toolName,
    input: JSON.stringify(known.input),
  };
}

/** Drop-in `repairToolCall` for streamText / ToolLoopAgent (issue #1515). */
export async function repairLeakedToolCall(options: {
  toolCall: { toolCallId?: string; toolName?: string; input?: unknown };
  tools?: Record<string, unknown> | null;
  error?: unknown;
}): Promise<{
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: string;
} | null> {
  return salvageLeakedToolCall(options.toolCall, options.tools ?? undefined);
}

/**
 * Streaming filter: hold back text from a markup opener until the closer
 * arrives (or flush), so `<tool_call>` split across text-deltas never
 * reaches Slack a token at a time. When `toolNames` is provided, also
 * neutralize bare registry names and `_suffix` fragments (issue #1524).
 */
export function createToolMarkupBuffer(
  toolNames?: Iterable<string> | null,
): ToolMarkupBuffer {
  let pending = "";
  let leaked = false;
  const collected: string[] = [];
  const leakTokens = collectToolNameLeakTokens(toolNames);
  const leakNames = leakTokens.length > 0 ? leakTokens : null;

  const note = (samples: string[]) => {
    if (samples.length === 0) return;
    leaked = true;
    for (const sample of samples) {
      if (collected.length >= 5) break;
      if (!collected.includes(sample)) collected.push(sample);
    }
  };

  const scrub = (text: string): string => {
    if (!text) return "";
    const stripped = stripLeakedToolNameFragments(text, leakNames);
    note(stripped.samples);
    if (stripped.stripped) leaked = true;
    return stripped.text;
  };

  return {
    push(delta: string): string {
      if (!delta) return "";
      pending += delta;
      let emit = "";

      while (pending) {
        const openerIdx = indexOfOpener(pending);
        if (openerIdx < 0) {
          const incomplete = INCOMPLETE_TAG_AT_END_RE.exec(pending);
          INCOMPLETE_TAG_AT_END_RE.lastIndex = 0;
          if (incomplete && incomplete.index != null) {
            emit += pending.slice(0, incomplete.index);
            pending = pending.slice(incomplete.index);
          } else {
            emit += pending;
            pending = "";
          }
          break;
        }

        emit += pending.slice(0, openerIdx);
        const rest = pending.slice(openerIdx);
        const closedEnd = matchingCloseEnd(rest);
        if (closedEnd == null) {
          pending = rest;
          break;
        }
        const block = rest.slice(0, closedEnd);
        const stripped = stripToolCallMarkup(block);
        note(stripped.samples);
        if (stripped.stripped) leaked = true;
        emit += stripped.text;
        pending = rest.slice(closedEnd);
      }

      // Hold a trailing `_hist` / `read_channel` until the next delta so a
      // split `read_channel_history` is stripped as one token, not leaked.
      if (!pending && leakTokens.length > 0) {
        const split = holdIncompleteToolNameToken(emit, leakTokens);
        emit = split.emit;
        pending = split.hold;
      }

      return scrub(emit);
    },
    flush(): string {
      if (!pending) return "";
      const stripped = sanitizeAssistantSlackText(pending, leakNames);
      pending = "";
      note(stripped.samples);
      if (stripped.stripped) leaked = true;
      return stripped.text;
    },
    didLeak(): boolean {
      return leaked;
    },
    samples(): string[] {
      return [...collected];
    },
  };
}

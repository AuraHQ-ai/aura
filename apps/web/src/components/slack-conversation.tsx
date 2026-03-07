"use client";

import * as React from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

export type TextNode = {
  type: "text";
  text: string;
};

export type ToolCallNode = {
  type: "tool_call";
  /** Tool name, e.g. "read_channel_history" */
  name: string;
  /** Optional label to show in collapsed state, e.g. "(OK)" or "(ERROR)" */
  status?: "ok" | "error";
  /** Expanded content — input args, output, etc. */
  detail?: string;
};

export type ContentNode = TextNode | ToolCallNode;

export type SlackMessage = {
  author: string;
  /** Full URL to avatar image */
  avatar: string;
  /** Display timestamp, e.g. "11:34 PM" */
  timestamp: string;
  /** Shows the "APP" badge next to the author name */
  isApp?: boolean;
  /** Interleaved text + tool call nodes */
  content: ContentNode[];
};

export type SlackConversationProps = {
  messages: SlackMessage[];
  /** Optional max-width override, e.g. "680px". Defaults to 680px */
  maxWidth?: string;
};

// ── Slack mrkdwn parser ──────────────────────────────────────────────────────
// Converts Slack mrkdwn to React nodes. Order matters: pre-block first,
// then inline patterns.

function parseMrkdwn(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let key = 0;

  // Split by ```pre``` blocks first
  const parts = text.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (part.startsWith("```") && part.endsWith("```")) {
      const code = part.slice(3, -3);
      nodes.push(
        <pre
          key={key++}
          style={{
            background: "var(--code-bg, #f0f0f0)",
            border: "1px solid var(--code-border, #e0e0e0)",
            borderRadius: "4px",
            padding: "8px 12px",
            fontSize: "12px",
            lineHeight: "1.5",
            overflowX: "auto",
            margin: "4px 0",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          <code style={{ color: "var(--pre-color, inherit)", background: "none" }}>
            {code}
          </code>
        </pre>
      );
      continue;
    }

    // Process inline mrkdwn — split into lines to handle > blockquotes
    const lines = part.split("\n");
    const lineNodes: React.ReactNode[] = [];

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];

      if (li > 0) lineNodes.push(<br key={`br-${key++}`} />);

      // > blockquote
      if (line.startsWith(">")) {
        lineNodes.push(
          <span
            key={key++}
            style={{
              display: "block",
              borderLeft: "4px solid var(--col-border, #ccc)",
              paddingLeft: "8px",
              color: "var(--text-secondary, #666)",
              margin: "2px 0",
            }}
          >
            {parseInline(line.slice(1).trimStart(), key)}
          </span>
        );
        key += 100;
        continue;
      }

      // Bullet lists (* or - at start of line)
      if (/^[*\-] /.test(line)) {
        lineNodes.push(
          <span key={key++} style={{ display: "block", paddingLeft: "16px" }}>
            <span style={{ marginLeft: "-12px", marginRight: "4px" }}>•</span>
            {parseInline(line.slice(2), key)}
          </span>
        );
        key += 100;
        continue;
      }

      lineNodes.push(...parseInline(line, key));
      key += 100;
    }

    nodes.push(...lineNodes);
  }

  return nodes;
}

function parseInline(text: string, baseKey: number): React.ReactNode[] {
  // Pattern order matters: bold > italic > strike > code > mention > channel > link
  const PATTERNS: [RegExp, (m: RegExpMatchArray, k: number) => React.ReactNode][] = [
    // Bold: *text*
    [
      /\*([^*\n]+)\*/g,
      (m, k) => <strong key={k} style={{ fontWeight: 700 }}>{m[1]}</strong>,
    ],
    // Italic: _text_
    [
      /\_([^_\n]+)\_/g,
      (m, k) => <em key={k}>{m[1]}</em>,
    ],
    // Strikethrough: ~text~
    [
      /~([^~\n]+)~/g,
      (m, k) => <s key={k}>{m[1]}</s>,
    ],
    // Inline code: `text`
    [
      /`([^`\n]+)`/g,
      (m, k) => (
        <code
          key={k}
          style={{
            background: "var(--code-bg, #f0f0f0)",
            color: "var(--code-color, #c0143c)",
            border: "1px solid var(--code-border, #e0e0e0)",
            borderRadius: "3px",
            padding: "1px 5px",
            fontSize: "0.85em",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {m[1]}
        </code>
      ),
    ],
    // Slack link: <url|label> or <url>
    [
      /<(https?:\/\/[^|>]+)(?:\|([^>]+))?>/g,
      (m, k) => (
        <a
          key={k}
          href={m[1]}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#1264a3", textDecoration: "none" }}
        >
          {m[2] || m[1]}
        </a>
      ),
    ],
    // @mention
    [
      /@([\w.]+)/g,
      (m, k) => (
        <span
          key={k}
          style={{
            background: "rgba(18,100,163,0.1)",
            color: "#1264a3",
            borderRadius: "3px",
            padding: "0 3px",
          }}
        >
          @{m[1]}
        </span>
      ),
    ],
    // #channel
    [
      /#([\w-]+)/g,
      (m, k) => (
        <span
          key={k}
          style={{
            background: "rgba(18,100,163,0.1)",
            color: "#1264a3",
            borderRadius: "3px",
            padding: "0 3px",
          }}
        >
          #{m[1]}
        </span>
      ),
    ],
  ];

  // We need to process patterns sequentially, splitting text around matches
  // Use a segment-based approach to avoid nested parsing issues
  interface Segment {
    type: "text" | "node";
    value?: string;
    node?: React.ReactNode;
  }

  let segments: Segment[] = [{ type: "text", value: text }];

  for (const [pattern, renderer] of PATTERNS) {
    const newSegments: Segment[] = [];
    for (const seg of segments) {
      if (seg.type !== "text" || !seg.value) {
        newSegments.push(seg);
        continue;
      }

      const str = seg.value;
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      pattern.lastIndex = 0;

      while ((match = pattern.exec(str)) !== null) {
        if (match.index > lastIndex) {
          newSegments.push({ type: "text", value: str.slice(lastIndex, match.index) });
        }
        newSegments.push({ type: "node", node: renderer(match, baseKey++) });
        lastIndex = match.index + match[0].length;
      }

      if (lastIndex < str.length) {
        newSegments.push({ type: "text", value: str.slice(lastIndex) });
      }
    }
    segments = newSegments;
  }

  return segments.map((seg, i) =>
    seg.type === "text" ? (
      <React.Fragment key={`t-${baseKey}-${i}`}>{seg.value}</React.Fragment>
    ) : (
      (seg.node as React.ReactNode)
    )
  );
}

// ── ToolCallBlock ────────────────────────────────────────────────────────────

function ToolCallBlock({ node }: { node: ToolCallNode }) {
  const [open, setOpen] = React.useState(false);

  const statusColor =
    node.status === "error"
      ? "#e01e5a"
      : "var(--text-muted, #999)";

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <button
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            background: "var(--bg-subtle, #f7f7f7)",
            border: "1px solid var(--col-border, #e5e5e5)",
            borderRadius: "6px",
            padding: "3px 8px",
            fontSize: "12px",
            cursor: "pointer",
            color: "var(--text-secondary, #555)",
            margin: "3px 0",
            transition: "background 0.1s",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          <ChevronRight
            size={12}
            style={{
              transition: "transform 0.15s",
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              flexShrink: 0,
            }}
          />
          <span style={{ fontWeight: 500 }}>[{node.name}]</span>
          {node.status && (
            <span style={{ color: statusColor, marginLeft: "2px" }}>
              ({node.status.toUpperCase()})
            </span>
          )}
        </button>
      </Collapsible.Trigger>
      {node.detail && (
        <Collapsible.Content
          style={{
            overflow: "hidden",
          }}
        >
          <pre
            style={{
              background: "var(--bg-subtle, #f7f7f7)",
              border: "1px solid var(--col-border, #e5e5e5)",
              borderRadius: "6px",
              borderTopLeftRadius: "0",
              borderTopRightRadius: "0",
              padding: "8px 12px",
              fontSize: "11px",
              lineHeight: "1.5",
              overflowX: "auto",
              maxHeight: "200px",
              overflowY: "auto",
              margin: 0,
              marginTop: "-1px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              color: "var(--text-secondary, #555)",
            }}
          >
            {node.detail}
          </pre>
        </Collapsible.Content>
      )}
    </Collapsible.Root>
  );
}

// ── SlackMessage ─────────────────────────────────────────────────────────────

function SlackMessageRow({ message }: { message: SlackMessage }) {
  return (
    <div
      style={{
        display: "flex",
        gap: "12px",
        padding: "6px 16px",
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.background =
          "var(--bg-subtle, #f7f7f7)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "transparent";
      }}
    >
      {/* Avatar */}
      <div style={{ flexShrink: 0, paddingTop: "2px" }}>
        <img
          src={message.avatar}
          alt={message.author}
          width={36}
          height={36}
          style={{
            borderRadius: "6px",
            objectFit: "cover",
            display: "block",
          }}
        />
      </div>

      {/* Body */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header row */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: "6px",
            marginBottom: "2px",
          }}
        >
          <span
            style={{
              fontWeight: 700,
              fontSize: "15px",
              color: "var(--text-primary, #111)",
            }}
          >
            {message.author}
          </span>
          {message.isApp && (
            <span
              style={{
                fontSize: "10px",
                fontWeight: 700,
                background: "var(--tag-bg, #e8e8e8)",
                color: "var(--tag-color, #555)",
                border: "1px solid var(--tag-border, #d0d0d0)",
                borderRadius: "3px",
                padding: "0 4px",
                lineHeight: "16px",
                letterSpacing: "0.02em",
              }}
            >
              APP
            </span>
          )}
          <span
            style={{
              fontSize: "12px",
              color: "var(--text-muted, #999)",
            }}
          >
            {message.timestamp}
          </span>
        </div>

        {/* Content nodes */}
        <div
          style={{
            fontSize: "15px",
            lineHeight: "1.46668",
            color: "var(--text-primary, #111)",
          }}
        >
          {message.content.map((node, i) => {
            if (node.type === "text") {
              return (
                <span key={i}>
                  {parseMrkdwn(node.text)}
                </span>
              );
            }
            if (node.type === "tool_call") {
              return (
                <div key={i} style={{ display: "block" }}>
                  <ToolCallBlock node={node} />
                </div>
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}

// ── SlackConversation ────────────────────────────────────────────────────────

export function SlackConversation({ messages, maxWidth = "680px" }: SlackConversationProps) {
  return (
    <div
      style={{
        maxWidth,
        fontFamily:
          '"Lato", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
        background: "var(--bg, #fff)",
        border: "1px solid var(--col-border, #e5e5e5)",
        borderRadius: "12px",
        overflow: "hidden",
        padding: "8px 0",
      }}
    >
      {messages.map((msg, i) => (
        <SlackMessageRow key={i} message={msg} />
      ))}
    </div>
  );
}

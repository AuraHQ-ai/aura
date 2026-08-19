"use client";

import * as React from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { Check, X } from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

export type TextNode = {
  type: "text";
  text: string;
};

export type ToolCallNode = {
  type: "tool_call";
  /** Tool name, e.g. "read_channel_history" */
  name: string;
  /** Status badge */
  status?: "ok" | "error";
  /** Expanded content */
  detail?: string;
  /** Whether the accordion is open by default */
  open?: boolean;
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
  /** Whether avatar is rounded (human) or square (bot/app). Default: rounded for humans, squircle for apps */
  avatarShape?: "round" | "square";
  /** Interleaved text + tool call nodes */
  content: ContentNode[];
};

export type SlackConversationProps = {
  messages: SlackMessage[];
  /** Optional max-width override. Defaults to 680px */
  maxWidth?: string;
  /** Dark or light theme override. Defaults to CSS var cascade (system). */
  theme?: "dark" | "light";
  /** Extra CSS class(es) applied to the root div */
  className?: string;
};

// ── Slack mrkdwn parser ──────────────────────────────────────────────────────

function parseMrkdwn(text: string, dark: boolean): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let key = 0;
  const textColor = dark ? "#d1d2d3" : "#1d1c1d";
  const channelColor = dark ? "#4bc0ff" : "#1264a3";
  const mentionBg = dark ? "rgba(75,192,255,0.15)" : "rgba(18,100,163,0.1)";
  const codeBg = dark ? "#1a1d21" : "#f8f8f8";
  const codeBorder = dark ? "#36393f" : "#e0e0e0";
  const codeColor = dark ? "#e8912d" : "#c0143c";
  const preBg = dark ? "#1a1d21" : "#f4f5f6";
  const preBorder = dark ? "#36393f" : "#e0e0e0";

  // Split by ```pre``` blocks first
  const parts = text.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (part.startsWith("```") && part.endsWith("```")) {
      const code = part.slice(3, -3).replace(/^\n/, "");
      nodes.push(
        <pre
          key={key++}
          style={{
            background: preBg,
            border: `1px solid ${preBorder}`,
            borderRadius: "4px",
            padding: "8px 12px",
            fontSize: "12px",
            fontFamily: '"Slack-Mono","Monaco","Menlo","Courier New",monospace',
            lineHeight: "1.5",
            overflowX: "auto",
            margin: "4px 0",
            color: textColor,
            whiteSpace: "pre-wrap",
          }}
        >
          {code}
        </pre>
      );
      continue;
    }

    // Process line by line to handle numbered lists, bullets, blockquotes
    const lines = part.split("\n");
    const lineNodes: React.ReactNode[] = [];

    // Pre-pass: collect table line groups
    const tableRanges: { start: number; end: number }[] = [];
    {
      let ti = 0;
      while (ti < lines.length) {
        if (lines[ti].trim().startsWith("|")) {
          const start = ti;
          while (ti < lines.length && lines[ti].trim().startsWith("|")) ti++;
          tableRanges.push({ start, end: ti - 1 });
        } else {
          ti++;
        }
      }
    }
    const tableLineSet = new Set<number>();
    tableRanges.forEach(({ start, end }) => {
      for (let i = start; i <= end; i++) tableLineSet.add(i);
    });

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];

      // Markdown table: consecutive lines starting with |
      if (tableLineSet.has(li)) {
        // Find the full range for this table
        const range = tableRanges.find(r => r.start === li);
        if (range) {
          const tableLines = lines.slice(range.start, range.end + 1)
            .filter(l => !l.trim().match(/^\|[-\s|:]+\|$/)); // drop separator row
          const headerLine = tableLines[0];
          const dataLines = tableLines.slice(1);
          const parseRow = (row: string) =>
            row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
          const headers = parseRow(headerLine);
          const rows = dataLines.map(parseRow);
          const borderCol = dark ? "#36393f" : "#e5e5e5";
          const headerBg = dark ? "#222529" : "#f8f8f8";
          lineNodes.push(
            <div key={`${key++}-tbl`} style={{ overflowX: "auto", margin: "6px 0" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "14px" }}>
                <thead>
                  <tr>
                    {headers.map((h, hi) => (
                      <th
                        key={hi}
                        style={{
                          border: `1px solid ${borderCol}`,
                          padding: "4px 10px",
                          background: headerBg,
                          fontWeight: 600,
                          textAlign: "left",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {parseInline(h, key++, dark)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td
                          key={ci}
                          style={{
                            border: `1px solid ${borderCol}`,
                            padding: "4px 10px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {parseInline(cell, key++, dark)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
          li = range.end; // skip to end of table
          continue;
        }
        continue; // skip individual table lines already consumed
      }

      // Blockquote: lines starting with >
      if (line.startsWith("> ") || line === ">") {
        lineNodes.push(
          <div
            key={`${key++}-q`}
            style={{
              borderLeft: `3px solid ${dark ? "#444" : "#ccc"}`,
              paddingLeft: "12px",
              color: dark ? "#999" : "#777",
              margin: "2px 0",
            }}
          >
            {parseInline(line.slice(2), key++, dark)}
          </div>
        );
        continue;
      }

      // Numbered list: "1. text"
      const numMatch = line.match(/^(\d+)\.\s+(.*)$/);
      if (numMatch) {
        lineNodes.push(
          <div key={`${key++}-n`} style={{ display: "flex", gap: "6px", margin: "1px 0" }}>
            <span style={{ color: channelColor, fontWeight: 700, minWidth: "16px" }}>{numMatch[1]}.</span>
            <span>{parseInline(numMatch[2], key++, dark)}</span>
          </div>
        );
        continue;
      }

      // Bullet: "* text" or "• text"
      const bulletMatch = line.match(/^[*•]\s+(.*)$/);
      if (bulletMatch) {
        lineNodes.push(
          <div key={`${key++}-b`} style={{ display: "flex", gap: "8px", margin: "1px 0" }}>
            <span style={{ color: dark ? "#999" : "#777" }}>•</span>
            <span>{parseInline(bulletMatch[1], key++, dark)}</span>
          </div>
        );
        continue;
      }

      // Empty line = paragraph break
      if (line === "") {
        lineNodes.push(<div key={`${key++}-br`} style={{ height: "8px" }} />);
        continue;
      }

      // Normal line
      lineNodes.push(
        <div key={`${key++}-l`}>
          {parseInline(line, key++, dark)}
        </div>
      );
    }

    nodes.push(...lineNodes);
  }

  return nodes;
}

function parseInline(text: string, baseKey: number, dark: boolean): React.ReactNode {
  const channelColor = dark ? "#4bc0ff" : "#1264a3";
  const mentionBg = dark ? "rgba(75,192,255,0.15)" : "rgba(18,100,163,0.1)";
  const codeBg = dark ? "#222529" : "#f8f8f8";
  const codeBorder = dark ? "#36393f" : "#e0e0e0";
  const codeColor = dark ? "#e8912d" : "#c0143c";
  const textColor = dark ? "#d1d2d3" : "#1d1c1d";

  // Tokenize: bold, italic, strike, code, @mention, #channel, url, emoji
  const pattern = /(\*[^*]+\*|_[^_]+_|~[^~]+~|`[^`]+`|<[^>]+>|:[a-z_]+:)/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = baseKey * 100;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(<React.Fragment key={key++}>{text.slice(last, match.index)}</React.Fragment>);
    }
    const token = match[0];

    if (token.startsWith("*") && token.endsWith("*") && token.length > 2) {
      parts.push(<strong key={key++} style={{ fontWeight: 700 }}>{token.slice(1, -1)}</strong>);
    } else if (token.startsWith("_") && token.endsWith("_") && token.length > 2) {
      parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("~") && token.endsWith("~") && token.length > 2) {
      parts.push(<del key={key++}>{token.slice(1, -1)}</del>);
    } else if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
      parts.push(
        <code
          key={key++}
          style={{
            background: codeBg,
            border: `1px solid ${codeBorder}`,
            borderRadius: "3px",
            padding: "0 4px",
            fontSize: "0.85em",
            fontFamily: '"Slack-Mono","Monaco","Menlo","Courier New",monospace',
            color: codeColor,
          }}
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("<") && token.endsWith(">")) {
      // Slack link format: <url|label> or <url> or <@mention> or <#channel>
      const inner = token.slice(1, -1);
      if (inner.startsWith("@")) {
        const rawId = inner.slice(1);
        // Resolve known Slack user IDs to display names for HTML rendering
        const name = rawId;
        parts.push(
          <span
            key={key++}
            style={{
              color: channelColor,
              background: mentionBg,
              borderRadius: "3px",
              padding: "0 2px",
            }}
          >
            @{name}
          </span>
        );
      } else if (inner.startsWith("#")) {
        const name = inner.slice(1);
        parts.push(
          <span key={key++} style={{ color: channelColor, cursor: "pointer" }}>
            #{name}
          </span>
        );
      } else {
        const [url, label] = inner.split("|");
        parts.push(
          <a key={key++} href={url} style={{ color: channelColor, textDecoration: "none" }} target="_blank" rel="noreferrer">
            {label || url}
          </a>
        );
      }
    } else if (token.startsWith("#") && token.length > 1) {
      // bare #channel
      parts.push(
        <span key={key++} style={{ color: channelColor, cursor: "pointer" }}>
          {token}
        </span>
      );
    } else if (token.startsWith(":") && token.endsWith(":")) {
      // emoji -- keep as-is, maybe map common ones later
      const name = token.slice(1, -1);
      const emojiMap: Record<string, string> = {
        white_check_mark: "✅", check: "✓", x: "❌", eyes: "👀",
        thumbsup: "👍", thumbsdown: "👎", fire: "🔥", rocket: "🚀",
        warning: "⚠️", tada: "🎉", chart_with_upwards_trend: "📈",
        chart_with_downwards_trend: "📉", memo: "📝", bug: "🐛",
        wrench: "🔧", bulb: "💡", star: "⭐", heart: "❤️",
        zap: "⚡", lock: "🔒", key: "🔑", mag: "🔍",
        mailbox_with_mail: "📬", alarm_clock: "⏰", red_circle: "🔴",
        money_with_wings: "💸", globe_with_meridians: "🌐",
        closed_lock_with_key: "🔐", clipboard: "📋", new: "🆕",
        receipt: "🧾", page_facing_up: "📄", robot_face: "🤖",
        moneybag: "💰",
      };
      parts.push(<span key={key++}>{emojiMap[name] || token}</span>);
    } else {
      parts.push(<React.Fragment key={key++}>{token}</React.Fragment>);
    }

    last = match.index + token.length;
  }

  if (last < text.length) {
    parts.push(<React.Fragment key={key++}>{text.slice(last)}</React.Fragment>);
  }

  // Also handle bare #channel not caught by pattern (before the <> form)
  return <>{parts}</>;
}

// ── ToolCallBlock ─────────────────────────────────────────────────────────────

function ToolCallBlock({ node, dark }: { node: ToolCallNode; dark: boolean }) {
  const [open, setOpen] = React.useState(node.open ?? false);

  const borderColor = dark ? "#36393f" : "#d9d9d9";
  const bgColor = dark ? "#222529" : "#f7f7f7";
  const bgHover = dark ? "#2a2e34" : "#f0f0f0";
  const textMuted = dark ? "#8a8b8c" : "#888";
  const statusOkColor = dark ? "#8a8b8c" : "#888";
  const statusErrColor = "#e01e5a";
  const checkColor = dark ? "#6ac47b" : "#2ecc71";

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div
        style={{
          margin: "3px 0",
          border: `1px solid ${borderColor}`,
          borderRadius: "8px",
          overflow: "hidden",
          background: bgColor,
          display: "inline-flex",
          flexDirection: "column",
          maxWidth: "440px",
          width: "100%",
        }}
      >
        <Collapsible.Trigger asChild>
          <button
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "7px 12px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              textAlign: "left",
              width: "100%",
              color: textMuted,
            }}
          >
            {/* Status icon: checkmark/X always on LEFT */}
            <span style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
              {node.status === "error" ? (
                <X size={14} color={statusErrColor} />
              ) : (
                <Check size={14} color={checkColor} />
              )}
            </span>

            {/* Tool name: plain English, bold */}
            <span
              style={{
                fontSize: "13px",
                fontWeight: 700,
                color: dark ? "#d1d2d3" : "#1d1c1d",
                flex: 1,
              }}
            >
              {node.name}
            </span>

            {/* Caret on RIGHT, always present if expandable */}
            {node.detail && (
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                style={{
                  transform: open ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform 0.15s ease",
                  flexShrink: 0,
                }}
              >
                <path d="M4 6l4 4 4-4" stroke={textMuted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        </Collapsible.Trigger>

        {node.detail && (
          <Collapsible.Content>
            <div
              style={{
                padding: "8px 12px 10px",
                borderTop: `1px solid ${borderColor}`,
              }}
            >
              <div
                style={{
                  borderLeft: `3px solid ${dark ? "#555" : "#ccc"}`,
                  paddingLeft: "10px",
                  fontSize: "13px",
                  color: dark ? "#aaa" : "#555",
                  lineHeight: "1.5",
                }}
              >
                {node.detail}
              </div>
            </div>
          </Collapsible.Content>
        )}
      </div>
    </Collapsible.Root>
  );
}

// ── SlackMessageRow ───────────────────────────────────────────────────────────

function SlackMessageRow({
  message,
  prevMessage,
  dark,
}: {
  message: SlackMessage;
  prevMessage?: SlackMessage;
  dark: boolean;
}) {
  // Group consecutive messages from same author (same author = no avatar repeat)
  const sameAuthor = prevMessage && prevMessage.author === message.author;
  const textColor = dark ? "#d1d2d3" : "#1d1c1d";
  const nameColor = dark ? "#d1d2d3" : "#1d1c1d";
  const tsColor = dark ? "#757677" : "#999";
  const appBgColor = dark ? "#2a2d31" : "#e8e8e8";
  const appTextColor = dark ? "#9a9b9c" : "#666";
  const hoverBg = dark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)";

  const avatarShape = message.avatarShape ?? (message.isApp ? "square" : "round");
  const avatarBorderRadius = avatarShape === "round" ? "12px" : "6px";

  return (
    <div
      style={{
        display: "flex",
        gap: "0",
        padding: sameAuthor ? "1px 8px 1px 8px" : "6px 8px 2px 8px",
        position: "relative",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = hoverBg;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "transparent";
      }}
    >
      {/* Avatar column -- 36px wide */}
      <div style={{ width: "36px", marginRight: "8px", flexShrink: 0, paddingTop: sameAuthor ? "0" : "2px" }}>
        {!sameAuthor && (
          <img
            src={message.avatar}
            alt={message.author}
            width={36}
            height={36}
            style={{
              borderRadius: avatarBorderRadius,
              display: "block",
              objectFit: "cover",
            }}
          />
        )}
      </div>

      {/* Content column */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header: name + APP badge + timestamp */}
        {!sameAuthor && (
          <div style={{ display: "flex", alignItems: "baseline", gap: "6px", marginBottom: "2px" }}>
            <span
              style={{
                fontWeight: 700,
                fontSize: "15px",
                color: nameColor,
                lineHeight: "1.2",
              }}
            >
              {message.author}
            </span>
            {message.isApp && (
              <span
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  background: appBgColor,
                  color: appTextColor,
                  borderRadius: "3px",
                  padding: "1px 4px",
                  letterSpacing: "0.04em",
                  lineHeight: "1.4",
                  alignSelf: "center",
                }}
              >
                APP
              </span>
            )}
            <span style={{ fontSize: "11px", color: tsColor }}>
              {message.timestamp}
            </span>
          </div>
        )}

        {/* Message content -- interleaved text + tool calls */}
        <div
          style={{
            fontSize: "15px",
            lineHeight: "1.46668",
            color: textColor,
          }}
        >
          {message.content.map((node, i) => {
            if (node.type === "text") {
              return (
                <div key={i} style={{ display: "block" }}>
                  {parseMrkdwn(node.text, dark)}
                </div>
              );
            }
            if (node.type === "tool_call") {
              return (
                <div key={i} style={{ display: "block", margin: "3px 0" }}>
                  <ToolCallBlock node={node} dark={dark} />
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

// ── SlackConversation ─────────────────────────────────────────────────────────

export function SlackConversation({
  messages,
  maxWidth = "680px",
  theme,
  className,
}: SlackConversationProps) {
  // Detect dark from next-themes: checks class="dark" and data-theme="dark" on <html>
  const [themeDark, setThemeDark] = React.useState(false);
  React.useEffect(() => {
    const update = () => {
      const html = document.documentElement;
      const isDark =
        html.classList.contains("dark") ||
        html.getAttribute("data-theme") === "dark";
      setThemeDark(isDark);
    };
    update();
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => obs.disconnect();
  }, []);

  const dark = theme === "dark" ? true : theme === "light" ? false : themeDark;

  const bgColor = dark ? "#1a1d21" : "#ffffff";
  const borderColor = dark ? "#36393f" : "#e5e5e5";

  return (
    <div
      className={className}
      style={{
        maxWidth,
        fontFamily:
          'Slack-Lato,"Lato",ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif',
        background: bgColor,
        border: `1px solid ${borderColor}`,
        borderRadius: "4px",
        overflow: "hidden",
        padding: "8px 0",
      }}
    >
      {messages.map((msg, i) => (
        <SlackMessageRow
          key={i}
          message={msg}
          prevMessage={i > 0 ? messages[i - 1] : undefined}
          dark={dark}
        />
      ))}
    </div>
  );
}
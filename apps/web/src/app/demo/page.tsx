import { SlackConversation } from "@/components/slack-conversation";
import type { SlackMessage } from "@/components/slack-conversation";

const DEMO_MESSAGES: SlackMessage[] = [
  {
    author: "Joan Rodriguez",
    avatar: "https://unavatar.io/github/joanrod",
    timestamp: "11:22 PM",
    content: [
      {
        type: "text",
        text: "can you pull the *top 5 channels* by message volume this week and post a summary in <#general>?",
      },
    ],
  },
  {
    author: "Aura",
    avatar: "https://aurahq.ai/icon.svg",
    timestamp: "11:22 PM",
    isApp: true,
    avatarShape: "square",
    content: [
      { type: "text", text: "On it." },
      {
        type: "tool_call",
        name: "list_channels",
        status: "ok",
        detail: "Input: { \"limit\": 200 }\nOutput: 42 channels returned",
      },
      {
        type: "tool_call",
        name: "read_channel_history",
        status: "ok",
        detail: "Input: { \"channel\": \"general\", \"limit\": 50 }\nOutput: 50 messages fetched",
      },
      {
        type: "text",
        text: "Here's the breakdown for the past 7 days:\n\n1. <#general> — 312 messages\n2. <#engineering> — 287 messages\n3. <#spain> — 201 messages\n4. <#random> — 178 messages\n5. <#product> — 143 messages\n\nPosting the summary now.",
      },
      {
        type: "tool_call",
        name: "send_channel_message",
        status: "ok",
        detail: "Input: { \"channel\": \"general\", \"message\": \"Weekly top 5...\" }\nOutput: Message sent (ts: 1741384920.123)",
      },
      { type: "text", text: "Done. :white_check_mark:" },
    ],
  },
  {
    author: "Joan Rodriguez",
    avatar: "https://unavatar.io/github/joanrod",
    timestamp: "11:23 PM",
    content: [
      { type: "text", text: "nice, now do the same for _last month_ and put it in a `canvas`" },
    ],
  },
  {
    author: "Aura",
    avatar: "https://aurahq.ai/icon.svg",
    timestamp: "11:23 PM",
    isApp: true,
    avatarShape: "square",
    content: [
      {
        type: "tool_call",
        name: "read_channel_history",
        status: "ok",
        detail: "Fetching 30-day history across top channels...",
      },
      {
        type: "tool_call",
        name: "create_canvas",
        status: "ok",
        detail: "Input: { \"title\": \"Monthly Channel Volume Report\" }\nOutput: Canvas F0A1B2C3D created",
      },
      {
        type: "text",
        text: "Done — *Monthly Channel Volume Report* canvas is live. ~30 days of data, 5 channels ranked by total message count. Same pattern as the weekly view.",
      },
    ],
  },
];

export default function DemoPage() {
  return (
    <div style={{ padding: "48px 24px", maxWidth: "800px", margin: "0 auto" }}>
      <h1 style={{ marginBottom: "8px", fontSize: "24px", fontWeight: 700 }}>
        SlackConversation component demo
      </h1>
      <p style={{ marginBottom: "32px", color: "#888", fontSize: "14px" }}>
        Theme-aware · mrkdwn · tool call accordions · message grouping
      </p>
      <SlackConversation messages={DEMO_MESSAGES} />
    </div>
  );
}

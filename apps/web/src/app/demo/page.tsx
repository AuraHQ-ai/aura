import { SlackConversation } from "@/components/slack-conversation";
import type { SlackMessage } from "@/components/slack-conversation";

// ── Conversation 1: Sales leaderboard ────────────────────────────────────────

const SALES_LEADERBOARD: SlackMessage[] = [
  {
    author: "Joan Rodriguez",
    avatar: "https://unavatar.io/github/wieseljonas",
    timestamp: "9:14 AM",
    content: [
      { type: "text", text: "show the sales leaderboard this week" },
    ],
  },
  {
    author: "Aura",
    avatar: "https://aurahq.ai/icon.svg",
    timestamp: "9:14 AM",
    isApp: true,
    avatarShape: "square",
    content: [
      {
        type: "tool_call",
        name: "Querying BigQuery — deals closed this week...",
        status: "ok",
        detail: "SELECT closer_name, COUNT(*) as deals, SUM(mrr) as mrr FROM deals WHERE closed_at >= CURRENT_DATE - 7 AND stage = 'won' GROUP BY 1 ORDER BY 3 DESC LIMIT 10",
      },
      {
        type: "text",
        text: "| # | Rep | Deals | MRR |\n|---|-----|-------|-----|\n| 🥇 | Jenibel Ruiz | 9 | €4,320 |\n| 🥈 | Sergio Mora | 7 | €3,150 |\n| 🥉 | Manuel Osuna | 6 | €2,880 |\n| 4 | Cristina Moro | 5 | €2,100 |\n| 5 | Ilia Molina | 4 | €1,740 |\n\nJenibel is on a *3-week win streak* — her close rate is 68% vs the team average of 51%. Worth a shoutout in <#spain>.",
      },
    ],
  },
];

// ── Conversation 2: Ad spend by platform ─────────────────────────────────────

const AD_SPEND: SlackMessage[] = [
  {
    author: "Joan Rodriguez",
    avatar: "https://unavatar.io/github/wieseljonas",
    timestamp: "2:31 PM",
    content: [
      { type: "text", text: "what's our spend, CTR, CPC and CPA by platform for the sign up conversion event in the last 12 months?" },
    ],
  },
  {
    author: "Aura",
    avatar: "https://aurahq.ai/icon.svg",
    timestamp: "2:31 PM",
    isApp: true,
    avatarShape: "square",
    content: [
      {
        type: "tool_call",
        name: "Querying BigQuery — ad performance last 12 months...",
        status: "ok",
        detail: "SELECT platform, SUM(spend) as spend, SUM(clicks)/SUM(impressions) as ctr, SUM(spend)/SUM(clicks) as cpc, SUM(spend)/SUM(conversions) as cpa FROM ad_performance WHERE event = 'sign_up' AND date >= DATE_SUB(CURRENT_DATE, INTERVAL 12 MONTH) GROUP BY 1 ORDER BY 1",
      },
      {
        type: "text",
        text: "| Platform | Spend | CTR | CPC | CPA |\n|----------|-------|-----|-----|-----|\n| Google | €184,200 | 4.2% | €1.84 | €38 |\n| Meta | €97,400 | 1.8% | €3.21 | €52 |\n| LinkedIn | €43,600 | 0.6% | €8.90 | €141 |\n| Bing | €9,100 | 3.1% | €2.10 | €44 |\n\nGoogle is carrying this — best CTR, lowest CPA by a wide margin. LinkedIn's CPA is *3.7× worse* than Google for the same sign-up event. Would be worth reviewing if that budget is justified by deal quality downstream.",
      },
    ],
  },
];

// ── Conversation 3: Build failing on GitHub Actions ───────────────────────────

const BUILD_FAILING: SlackMessage[] = [
  {
    author: "Joan Rodriguez",
    avatar: "https://unavatar.io/github/wieseljonas",
    timestamp: "6:48 PM",
    content: [
      { type: "text", text: "the build is failing on github actions, investigate and suggest a fix" },
    ],
  },
  {
    author: "Aura",
    avatar: "https://aurahq.ai/icon.svg",
    timestamp: "6:48 PM",
    isApp: true,
    avatarShape: "square",
    content: [
      {
        type: "tool_call",
        name: "Fetching latest workflow runs...",
        status: "ok",
        detail: "gh run list --limit 5 --json name,status,conclusion,headBranch,createdAt",
      },
      {
        type: "tool_call",
        name: "Reading build logs...",
        status: "ok",
        detail: "gh run view 8471920344 --log-failed",
      },
      {
        type: "text",
        text: "Found it. The `ci.yml` lint step is failing on `main` since *6:31 PM* — 3 consecutive runs.\n\nError:\n```\nTypeError: Cannot read properties of undefined (reading 'map')\n  at generateLeadScore (src/scoring/leads.ts:84)\n```\n\nRoot cause: PR #1847 (merged 42 min ago) changed `lead.attributes` from an array to an object, but `generateLeadScore` still calls `.map()` on it.\n\n*Fix:*\n```ts\n// Before\nconst scores = lead.attributes.map(attr => weights[attr]);\n\n// After\nconst scores = Object.keys(lead.attributes).map(attr => weights[attr]);\n```\n\nThis is in `src/scoring/leads.ts:84`. Want me to open a PR?",
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
        Three real scenarios — data, ads, engineering
      </p>

      <h2 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "16px" }}>Sales leaderboard</h2>
      <SlackConversation messages={SALES_LEADERBOARD} />

      <h2 style={{ fontSize: "16px", fontWeight: 600, margin: "48px 0 16px" }}>Ad spend by platform</h2>
      <SlackConversation messages={AD_SPEND} />

      <h2 style={{ fontSize: "16px", fontWeight: 600, margin: "48px 0 16px" }}>Build failing — investigate and fix</h2>
      <SlackConversation messages={BUILD_FAILING} />
    </div>
  );
}

import { stackLogos } from "@/components/stack-logos";
import { SlackConversation } from "@/components/slack-conversation";
import type { SlackMessage } from "@/components/slack-conversation";

// ── Conversation 1: Sales leaderboard ────────────────────────────────────────

const SALES_LEADERBOARD: SlackMessage[] = [
  {
    author: "Jonas Wiesel",
    avatar: "https://unavatar.io/github/wieseljonas",
    timestamp: "9:14 AM",
    content: [
      { type: "text", text: "<@Aura> show the sales leaderboard this week" },
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
    author: "Jonas Wiesel",
    avatar: "https://unavatar.io/github/wieseljonas",
    timestamp: "2:31 PM",
    content: [
      { type: "text", text: "<@Aura> what's our spend, CTR, CPC and CPA by platform for the sign up conversion event in the last 12 months?" },
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
    author: "Jonas Wiesel",
    avatar: "https://unavatar.io/github/wieseljonas",
    timestamp: "6:48 PM",
    content: [
      { type: "text", text: "<@Aura> the build is failing on github actions, investigate and suggest a fix" },
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
        text: "Found it. The `ci.yml` lint step is failing on `main` since *6:31 PM* — 3 consecutive runs.\n\nError:\n```\nTypeError: Cannot read properties of undefined (reading 'map')\n  at generateLeadScore (src/scoring/leads.ts:84)\n```\n\nRoot cause: <https://github.com/org/repo/pull/1847|PR #1847> (merged 42 min ago) changed `lead.attributes` from an array to an object, but `generateLeadScore` still calls `.map()` on it.\n\n*Fix:*\n```ts\n// Before\nconst scores = lead.attributes.map(attr => weights[attr]);\n\n// After\nconst scores = Object.keys(lead.attributes).map(attr => weights[attr]);\n```\n\nThis is in `src/scoring/leads.ts:84`. Want me to open a PR?",
      },
    ],
  },
];


export default function Home() {
  return (
    <div className="site-inner">
      {/* Hero */}
      <section
        style={{
          padding: "96px 0 80px",
          borderBottom: "1px solid var(--col-border)",
        }}
      >
        <div style={{ maxWidth: "640px" }}>
          <p style={{ fontSize: "12px", fontWeight: 600, letterSpacing: "0.08em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "24px" }}>
            AI Colleague
          </p>
          <h1
            style={{
              fontSize: "clamp(2.25rem, 5vw, 3.5rem)",
              fontWeight: 700,
              letterSpacing: "-0.03em",
              lineHeight: 1.1,
              color: "var(--text-primary)",
              marginBottom: "24px",
            }}
          >
            Every day she works, she gets harder to replace.
          </h1>
          <p style={{ fontSize: "1.125rem", color: "var(--text-secondary)", lineHeight: 1.7, marginBottom: "40px", maxWidth: "520px" }}>
            Aura is an AI agent that joins your team, learns your business, and compounds over time. Not a chatbot. Not a wrapper. A colleague with memory.
          </p>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <a
              href="https://github.com/AuraHQ-ai/aura"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                background: "var(--btn-bg)",
                color: "var(--btn-color)",
                padding: "12px 24px",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: 500,
                letterSpacing: "-0.01em",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style={{ width: "16px", height: "16px", flexShrink: 0 }}>
                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
              Star on GitHub
            </a>
            <a
              href="https://docs.aurahq.ai"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                background: "var(--btn-secondary-bg)",
                color: "var(--btn-secondary-color)",
                border: "1px solid var(--col-border)",
                padding: "12px 24px",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: 500,
                letterSpacing: "-0.01em",
                textDecoration: "none",
              }}
            >
              Read the docs →
            </a>
          </div>
        </div>
      </section>

      {/* Built with */}
      <section
        style={{
          padding: "40px 0",
          borderBottom: "1px solid var(--col-border)",
        }}
      >
        <p
          style={{
            fontSize: "11px",
            fontWeight: 600,
            letterSpacing: "0.1em",
            color: "var(--text-muted)",
            textTransform: "uppercase",
            marginBottom: "28px",
          }}
        >
          Built with the best stack in the game
        </p>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "32px",
            alignItems: "center",
          }}
        >
          {stackLogos.map((logo) => (
            <img
              key={logo.name}
              src={`/logos/${logo.file}.svg`}
              alt={logo.name}
              title={logo.name}
              height={20}
              style={{ height: "20px", width: "auto", display: "block", opacity: 0.35 }}
            />
          ))}
        </div>
      </section>

      {/* Features */}
      <section style={{ padding: "80px 0", borderBottom: "1px solid var(--col-border)" }}>
        <p style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.1em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "48px" }}>
          What she does
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: "1px",
            background: "var(--col-border)",
            border: "1px solid var(--col-border)",
          }}
        >
          {[
            { title: "Learns the context", desc: "Every Slack message, every decision, every conversation — she remembers. Context compounds across months and teams." },
            { title: "Makes decisions", desc: "She reads channels, spots problems, fires off the right action. No prompt required. No babysitting needed." },
            { title: "Compounds over time", desc: "Most tools are as dumb on day 365 as day 1. Aura gets harder to replace every week." },
            { title: "Your data stays yours", desc: "Runs on your infra. Connects to your BigQuery, your CRM, your calendar. No vendor lock-in." },
            { title: "Works in Slack", desc: "No new interface to learn. She lives where your team already works — channels, threads, DMs." },
            { title: "Integrates with your stack", desc: "Native connections to Notion, Google Workspace, GitHub, Close, Stripe, PostHog, and more." },
          ].map((f, i) => (
            <div
              key={i}
              style={{
                background: "var(--feature-card-bg)",
                padding: "32px",
              }}
            >
              <p style={{ fontSize: "0.9375rem", fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px", letterSpacing: "-0.01em" }}>{f.title}</p>
              <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", lineHeight: 1.65, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Live demos */}
      <section style={{ padding: "80px 0", borderBottom: "1px solid var(--col-border)" }}>
        <p style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.1em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "8px" }}>
          See it in action
        </p>
        <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "48px" }}>
          Real questions. Real answers. No prompting required.
        </p>
        <div className="demo-conversation-list" style={{ display: "flex", flexDirection: "column", gap: "48px", maxWidth: "720px" }}>
          <div>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "12px", fontWeight: 500, letterSpacing: "0.04em", textTransform: "uppercase" }}>Sales performance</p>
            <SlackConversation messages={SALES_LEADERBOARD} className="slack-conversation-flush" />
          </div>
          <div>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "12px", fontWeight: 500, letterSpacing: "0.04em", textTransform: "uppercase" }}>Marketing analytics</p>
            <SlackConversation messages={AD_SPEND} className="slack-conversation-flush" />
          </div>
          <div>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "12px", fontWeight: 500, letterSpacing: "0.04em", textTransform: "uppercase" }}>Engineering — build failing</p>
            <SlackConversation messages={BUILD_FAILING} className="slack-conversation-flush" />
          </div>
        </div>
      </section>

            {/* CTA */}
      <section style={{ padding: "96px 0" }}>
        <div style={{ maxWidth: "480px" }}>
          <h2 style={{ fontSize: "clamp(1.5rem, 3vw, 2.25rem)", fontWeight: 700, letterSpacing: "-0.03em", color: "var(--text-primary)", marginBottom: "16px" }}>
            Open source. Deploy it yourself.
          </h2>
          <p style={{ fontSize: "1rem", color: "var(--text-secondary)", lineHeight: 1.7, marginBottom: "32px" }}>
            Aura runs in Slack. She joins your channels, learns your team, and compounds over time. Star the repo and follow the docs to get her running in 30 minutes.
          </p>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <a
              href="https://github.com/AuraHQ-ai/aura"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                background: "var(--btn-bg)",
                color: "var(--btn-color)",
                padding: "13px 28px",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: 500,
                letterSpacing: "-0.01em",
                textDecoration: "none",
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style={{ width: "16px", height: "16px", flexShrink: 0 }}>
                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
              View on GitHub
            </a>
            <a
              href="https://docs.aurahq.ai"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                background: "var(--btn-secondary-bg)",
                color: "var(--btn-secondary-color)",
                border: "1px solid var(--col-border)",
                padding: "13px 28px",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: 500,
                letterSpacing: "-0.01em",
                textDecoration: "none",
              }}
            >
              Read the docs →
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

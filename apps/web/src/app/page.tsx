import { stackLogos } from "@/components/stack-logos";

const SLACK_CLIENT_ID = process.env.NEXT_PUBLIC_SLACK_CLIENT_ID ?? "YOUR_CLIENT_ID";
const SLACK_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:join",
  "channels:manage",
  "channels:read",
  "chat:write",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users:read",
  "users:read.email",
].join(",");
const SLACK_OAUTH_URL = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&scope=${SLACK_SCOPES}`;

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
            AI Assistant for Slack
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
            Aura is an AI assistant that lives in your Slack workspace — triaging bugs, analyzing data, coordinating your team, and building memory that compounds over time. Not a chatbot. A colleague.
          </p>
          <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "center" }}>
            <a
              href={SLACK_OAUTH_URL}
              style={{ display: "inline-block" }}
              aria-label="Add Aura to Slack"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt="Add to Slack"
                height="40"
                width="139"
                src="https://platform.slack-edge.com/img/add_to_slack.png"
                srcSet="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x"
                style={{ height: "40px", width: "auto" }}
              />
            </a>
            <a
              href="/blog"
              style={{
                background: "var(--btn-secondary-bg)",
                color: "var(--btn-secondary-color)",
                border: "1px solid var(--col-border)",
                padding: "8px 24px",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: 500,
                letterSpacing: "-0.01em",
                textDecoration: "none",
              }}
            >
              Read the blog
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
            { title: "Lives in Slack", desc: "No new interface to learn. Aura joins your channels, responds in threads, and works alongside your team where they already collaborate." },
            { title: "Remembers everything", desc: "Conversations, decisions, context — Aura builds persistent memory that compounds across months and teams. She gets smarter every day." },
            { title: "Autonomous actions", desc: "She reads channels, spots problems, and fires off the right action. Bug triage, data pulls, team coordination — no prompt required." },
            { title: "Data analysis", desc: "Connects to BigQuery, your CRM, and your metrics stack. Ask questions in plain English and get answers with full context." },
            { title: "Secure by design", desc: "Your data stays yours. Aura stores conversation summaries, not raw transcripts. No data is used for model training." },
            { title: "Integrates with your stack", desc: "Native connections to GitHub, Google Workspace, BigQuery, Close, Stripe, PostHog, Notion, and more." },
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

      {/* Day in the life */}
      <section style={{ padding: "80px 0", borderBottom: "1px solid var(--col-border)" }}>
        <p style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.1em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "8px" }}>
          This isn&apos;t a demo. This is a Tuesday.
        </p>
        <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "48px" }}>
          A real day. Real tasks. Zero prompts from anyone.
        </p>
        <div style={{ maxWidth: "640px" }}>
          {[
            { t: "10:00 AM", text: "Spots a spike in churn signals in #csm-france. Pulls the relevant accounts, cross-references renewal dates, DMs the CSM with a summary." },
            { t: "12:30 PM", text: "Joins a thread about a billing bug. Checks the error table, traces it to a Stripe webhook mismatch, files a GitHub issue with full context." },
            { t: "3:00 PM", text: "Runs the monthly churn analysis. Surfaces 3 accounts at risk. CSM already has the context." },
            { t: "5:00 PM", text: "Writes and ships a PR to fix a retrieval bug she noticed in her own memory system." },
          ].map((item, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "80px 1fr",
                gap: "24px",
                padding: "20px 0",
                borderTop: i === 0 ? "1px solid var(--col-border)" : "none",
                borderBottom: "1px solid var(--col-border)",
              }}
            >
              <span style={{ fontSize: "12px", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", paddingTop: "2px" }}>{item.t}</span>
              <p style={{ fontSize: "0.9375rem", color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>{item.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* AI & Data Transparency */}
      <section style={{ padding: "80px 0", borderBottom: "1px solid var(--col-border)" }}>
        <p style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.1em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "16px" }}>
          AI &amp; Data Transparency
        </p>
        <div style={{ maxWidth: "640px" }}>
          <p style={{ fontSize: "1rem", color: "var(--text-secondary)", lineHeight: 1.75, marginBottom: "24px" }}>
            Aura uses large language models (Anthropic Claude) to understand messages, generate responses, and take actions in your workspace. Here&apos;s how we handle your data:
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginBottom: "24px" }}>
            {[
              { label: "Summaries, not transcripts", text: "Aura stores conversation summaries and structured notes — not raw message transcripts. Your full chat history stays in Slack." },
              { label: "No model training", text: "Your workspace data is never used to train or fine-tune AI models. Conversations are processed in real-time and not retained by the model provider." },
              { label: "LLM-powered responses", text: "All of Aura's responses are generated by Anthropic Claude. Aura clearly identifies itself as an AI assistant in every interaction." },
              { label: "You control access", text: "Aura only accesses channels it's invited to. You can remove Aura from any channel at any time, and uninstall from your workspace instantly." },
            ].map((item, i) => (
              <div
                key={i}
                style={{
                  padding: "20px 24px",
                  background: "var(--feature-card-bg)",
                  border: "1px solid var(--col-border)",
                  borderRadius: "8px",
                }}
              >
                <p style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--text-primary)", marginBottom: "4px" }}>{item.label}</p>
                <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", lineHeight: 1.65, margin: 0 }}>{item.text}</p>
              </div>
            ))}
          </div>
          <a
            href="/legal/data-handling"
            style={{
              fontSize: "0.875rem",
              color: "var(--text-primary)",
              textDecoration: "underline",
              textUnderlineOffset: "3px",
            }}
          >
            Read our full data handling policy →
          </a>
        </div>
      </section>

      {/* CTA */}
      <section style={{ padding: "96px 0" }}>
        <div style={{ maxWidth: "480px" }}>
          <h2 style={{ fontSize: "clamp(1.5rem, 3vw, 2.25rem)", fontWeight: 700, letterSpacing: "-0.03em", color: "var(--text-primary)", marginBottom: "16px" }}>
            Ready to add Aura to your workspace?
          </h2>
          <p style={{ fontSize: "1rem", color: "var(--text-secondary)", lineHeight: 1.7, marginBottom: "32px" }}>
            Aura runs in Slack. She joins your channels, learns your team, and starts working on day one. No setup wizard. No onboarding call.
          </p>
          <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "center" }}>
            <a
              href={SLACK_OAUTH_URL}
              style={{ display: "inline-block" }}
              aria-label="Add Aura to Slack"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt="Add to Slack"
                height="40"
                width="139"
                src="https://platform.slack-edge.com/img/add_to_slack.png"
                srcSet="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x"
                style={{ height: "40px", width: "auto" }}
              />
            </a>
            <a
              href="mailto:hello@aurahq.ai"
              style={{
                fontSize: "14px",
                color: "var(--text-secondary)",
                textDecoration: "underline",
                textUnderlineOffset: "3px",
              }}
            >
              Or contact us at hello@aurahq.ai
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

import { stackLogos } from "@/components/stack-logos";

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

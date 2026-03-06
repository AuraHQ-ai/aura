import { stackLogos } from "@/components/stack-logos";

export default function Home() {
  return (
    <div className="site-inner">
      {/* Hero */}
      <section
        style={{
          padding: "96px 0 80px",
          borderBottom: "1px solid #e5e5e5",
        }}
      >
        <div style={{ maxWidth: "640px" }}>
          <p style={{ fontSize: "12px", fontWeight: 600, letterSpacing: "0.08em", color: "#999", textTransform: "uppercase", marginBottom: "24px" }}>
            AI Colleague
          </p>
          <h1
            style={{
              fontSize: "clamp(2.25rem, 5vw, 3.5rem)",
              fontWeight: 700,
              letterSpacing: "-0.03em",
              lineHeight: 1.1,
              color: "#111",
              marginBottom: "24px",
            }}
          >
            Every day she works, she gets harder to replace.
          </h1>
          <p style={{ fontSize: "1.125rem", color: "#555", lineHeight: 1.7, marginBottom: "40px", maxWidth: "520px" }}>
            Aura is an AI agent that joins your team, learns your business, and compounds over time. Not a chatbot. Not a wrapper. A colleague with memory.
          </p>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <a
              href="mailto:hello@aurahq.ai"
              style={{
                background: "#111",
                color: "#fff",
                padding: "12px 24px",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: 500,
                letterSpacing: "-0.01em",
                textDecoration: "none",
              }}
            >
              Request access
            </a>
            <a
              href="/blog"
              style={{
                background: "#fff",
                color: "#111",
                border: "1px solid #e5e5e5",
                padding: "12px 24px",
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
          borderBottom: "1px solid #e5e5e5",
        }}
      >
        <p
          style={{
            fontSize: "11px",
            fontWeight: 600,
            letterSpacing: "0.1em",
            color: "#bbb",
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
      <section style={{ padding: "80px 0", borderBottom: "1px solid #e5e5e5" }}>
        <p style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.1em", color: "#bbb", textTransform: "uppercase", marginBottom: "48px" }}>
          What she does
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: "1px",
            background: "#e5e5e5",
            border: "1px solid #e5e5e5",
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
                background: "#fff",
                padding: "32px",
              }}
            >
              <p style={{ fontSize: "0.9375rem", fontWeight: 600, color: "#111", marginBottom: "8px", letterSpacing: "-0.01em" }}>{f.title}</p>
              <p style={{ fontSize: "0.875rem", color: "#777", lineHeight: 1.65, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Day in the life */}
      <section style={{ padding: "80px 0", borderBottom: "1px solid #e5e5e5" }}>
        <p style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.1em", color: "#bbb", textTransform: "uppercase", marginBottom: "8px" }}>
          This isn&apos;t a demo. This is a Tuesday.
        </p>
        <p style={{ fontSize: "0.875rem", color: "#999", marginBottom: "48px" }}>
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
                borderTop: i === 0 ? "1px solid #e5e5e5" : "none",
                borderBottom: "1px solid #e5e5e5",
              }}
            >
              <span style={{ fontSize: "12px", color: "#bbb", fontVariantNumeric: "tabular-nums", paddingTop: "2px" }}>{item.t}</span>
              <p style={{ fontSize: "0.9375rem", color: "#444", lineHeight: 1.6, margin: 0 }}>{item.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section style={{ padding: "96px 0" }}>
        <div style={{ maxWidth: "480px" }}>
          <h2 style={{ fontSize: "clamp(1.5rem, 3vw, 2.25rem)", fontWeight: 700, letterSpacing: "-0.03em", color: "#111", marginBottom: "16px" }}>
            Ready to hire her?
          </h2>
          <p style={{ fontSize: "1rem", color: "#666", lineHeight: 1.7, marginBottom: "32px" }}>
            Aura runs in Slack. She joins your channels, learns your team, and starts working on day one. No setup wizard. No onboarding call.
          </p>
          <a
            href="mailto:hello@aurahq.ai"
            style={{
              display: "inline-block",
              background: "#111",
              color: "#fff",
              padding: "13px 28px",
              borderRadius: "8px",
              fontSize: "14px",
              fontWeight: 500,
              letterSpacing: "-0.01em",
              textDecoration: "none",
            }}
          >
            Get in touch →
          </a>
        </div>
      </section>
    </div>
  );
}

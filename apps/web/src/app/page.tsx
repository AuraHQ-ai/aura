export default function Home() {
  return (
    <div style={{ padding: "0 48px" }}>
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
              }}
            >
              Read the blog →
            </a>
          </div>
        </div>
      </section>

      {/* Stats bar */}
      <section
        style={{
          padding: "0",
          borderBottom: "1px solid #e5e5e5",
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
        }}
      >
        {[
          { n: "2,993", label: "conversations logged" },
          { n: "244", label: "knowledge notes" },
          { n: "20,000+", label: "memories indexed" },
        ].map((s, i) => (
          <div
            key={i}
            style={{
              padding: "32px 0",
              borderRight: i < 2 ? "1px solid #e5e5e5" : "none",
              paddingLeft: i > 0 ? "32px" : "0",
            }}
          >
            <div style={{ fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.03em", color: "#111" }}>{s.n}</div>
            <div style={{ fontSize: "13px", color: "#999", marginTop: "4px" }}>{s.label}</div>
          </div>
        ))}
      </section>

      {/* Differentiators */}
      <section style={{ padding: "80px 0", borderBottom: "1px solid #e5e5e5" }}>
        <p style={{ fontSize: "12px", fontWeight: 600, letterSpacing: "0.08em", color: "#999", textTransform: "uppercase", marginBottom: "48px" }}>
          How it works
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "48px 64px" }}>
          {[
            {
              n: "01",
              title: "Persistent memory",
              body: "Every conversation is stored, embedded, and retrieved. Aura remembers what matters — names, decisions, context — across weeks and months.",
            },
            {
              n: "02",
              title: "Autonomous work",
              body: "Recurring jobs, proactive monitoring, email digests, bug triage. Aura works without being asked, fires off when needed, and reports back.",
            },
            {
              n: "03",
              title: "Self-improvement",
              body: "Aura reads her own codebase, files issues, dispatches agents, merges PRs, and updates her own knowledge — an evolution loop that runs continuously.",
            },
            {
              n: "04",
              title: "Business context",
              body: "OKRs, product strategy, team org, deal pipeline. Aura builds a structured model of your business and brings it to every conversation.",
            },
          ].map((d) => (
            <div key={d.n}>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "#bbb", letterSpacing: "0.06em", marginBottom: "12px" }}>{d.n}</div>
              <h3 style={{ fontSize: "1rem", fontWeight: 600, color: "#111", marginBottom: "8px" }}>{d.title}</h3>
              <p style={{ fontSize: "0.9375rem", color: "#666", lineHeight: 1.65 }}>{d.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Tuesday section */}
      <section style={{ padding: "80px 0", borderBottom: "1px solid #e5e5e5" }}>
        <div style={{ maxWidth: "640px" }}>
          <p style={{ fontSize: "12px", fontWeight: 600, letterSpacing: "0.08em", color: "#999", textTransform: "uppercase", marginBottom: "24px" }}>
            This isn&apos;t a demo. This is a Tuesday.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
            {[
              { t: "8:00 AM", text: "Sends Jonas his email digest. 12 threads, triaged by urgency, with suggested replies for 3." },
              { t: "9:15 AM", text: "Spots a spike in Stripe webhook failures. Files a bug with reproduction steps. Pings Guillaume." },
              { t: "11:30 AM", text: "Joan shares a competitor video. Aura reads it, challenges the thesis, asks the uncomfortable question." },
              { t: "2:00 PM", text: "Runs the monthly churn analysis. Surfaces 3 accounts at risk. CSM already has the context." },
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
            }}
          >
            Get in touch →
          </a>
        </div>
      </section>
    </div>
  );
}

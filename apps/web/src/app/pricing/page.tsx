import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing — Aura",
  description: "Free forever. Open source. Self-host on your own infra or use Aura Cloud.",
};

export default function PricingPage() {
  return (
    <div className="site-inner">
      {/* Header */}
      <section style={{ padding: "80px 0 64px", borderBottom: "1px solid var(--col-border)" }}>
        <p style={{ fontSize: "12px", fontWeight: 600, letterSpacing: "0.08em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "16px" }}>
          Pricing
        </p>
        <h1 style={{ fontSize: "clamp(2rem, 4vw, 3rem)", fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.1, color: "var(--text-primary)", marginBottom: "20px" }}>
          Free forever. No tricks.
        </h1>
        <p style={{ fontSize: "1.125rem", color: "var(--text-secondary)", lineHeight: 1.7, maxWidth: "520px" }}>
          Aura is open source and self-hostable. Run it on your own infra at zero cost.
          Managed cloud is coming for teams who want zero ops.
        </p>
      </section>

      {/* Plans */}
      <section style={{ padding: "64px 0", borderBottom: "1px solid var(--col-border)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "24px", maxWidth: "900px" }}>

          {/* Self-host */}
          <div style={{
            border: "1px solid var(--col-border)",
            borderRadius: "12px",
            padding: "32px",
            background: "var(--bg-card, var(--bg-primary))",
          }}>
            <p style={{ fontSize: "12px", fontWeight: 600, letterSpacing: "0.08em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "12px" }}>
              Self-hosted
            </p>
            <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "8px" }}>
              <span style={{ fontSize: "2.5rem", fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.03em" }}>$0</span>
              <span style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>forever</span>
            </div>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginBottom: "32px", lineHeight: 1.6 }}>
              Deploy on Vercel + Neon Postgres. Your infra, your data, your control.
            </p>
            <ul style={{ listStyle: "none", padding: 0, margin: "0 0 32px 0", display: "flex", flexDirection: "column", gap: "10px" }}>
              {[
                "Full codebase, MIT license",
                "All tools — Slack, email, calendar, BigQuery, GitHub",
                "Persistent memory per person",
                "Scheduled jobs & heartbeat",
                "Self-improvement loop",
                "Unlimited workspaces",
              ].map((f) => (
                <li key={f} style={{ display: "flex", gap: "10px", alignItems: "flex-start", color: "var(--text-secondary)", fontSize: "0.9rem" }}>
                  <span style={{ color: "var(--text-primary)", flexShrink: 0, marginTop: "1px" }}>✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <a
              href="https://github.com/AuraHQ-ai/aura"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                background: "var(--btn-secondary-bg)",
                color: "var(--btn-secondary-color)",
                border: "1px solid var(--col-border)",
                padding: "11px 22px",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: 500,
                textDecoration: "none",
                width: "100%",
                justifyContent: "center",
                boxSizing: "border-box",
              }}
            >
              Deploy on GitHub →
            </a>
          </div>

          {/* Cloud */}
          <div style={{
            border: "1px solid var(--col-border)",
            borderRadius: "12px",
            padding: "32px",
            background: "var(--bg-card, var(--bg-primary))",
            position: "relative",
          }}>
            <div style={{
              position: "absolute",
              top: "-1px",
              left: "24px",
              right: "24px",
              height: "2px",
              background: "var(--text-primary)",
              borderRadius: "0 0 2px 2px",
            }} />
            <p style={{ fontSize: "12px", fontWeight: 600, letterSpacing: "0.08em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "12px" }}>
              Aura Cloud
            </p>
            <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "8px" }}>
              <span style={{ fontSize: "2.5rem", fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.03em" }}>Soon</span>
            </div>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", marginBottom: "32px", lineHeight: 1.6 }}>
              Managed hosting. No Vercel account, no Neon, no ops. Just add to Slack and go.
            </p>
            <ul style={{ listStyle: "none", padding: 0, margin: "0 0 32px 0", display: "flex", flexDirection: "column", gap: "10px" }}>
              {[
                "Everything in self-hosted",
                "Zero infrastructure setup",
                "Automatic updates",
                "Team billing",
                "Priority support",
              ].map((f) => (
                <li key={f} style={{ display: "flex", gap: "10px", alignItems: "flex-start", color: "var(--text-secondary)", fontSize: "0.9rem" }}>
                  <span style={{ color: "var(--text-primary)", flexShrink: 0, marginTop: "1px" }}>✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <a
              href="https://github.com/AuraHQ-ai/aura/discussions"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                background: "var(--btn-bg)",
                color: "var(--btn-color)",
                padding: "11px 22px",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: 500,
                textDecoration: "none",
                width: "100%",
                justifyContent: "center",
                boxSizing: "border-box",
              }}
            >
              Join waitlist →
            </a>
          </div>

        </div>
      </section>

      {/* Viktor comparison callout -- subtle */}
      <section style={{ padding: "64px 0", borderBottom: "1px solid var(--col-border)" }}>
        <h2 style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em", color: "var(--text-primary)", marginBottom: "12px" }}>
          Why free?
        </h2>
        <p style={{ color: "var(--text-secondary)", lineHeight: 1.7, maxWidth: "560px", marginBottom: "24px" }}>
          Other AI agents charge $50/workspace/month. We think that model is wrong.
          The agent that&apos;s embedded in your team and improving every day is worth
          more than one you&apos;re renting. So we open sourced it. Run it yourself,
          forever, for free.
        </p>
        <p style={{ color: "var(--text-secondary)", lineHeight: 1.7, maxWidth: "560px" }}>
          If you&apos;d rather not manage infra, Aura Cloud will handle that -- at a price
          that reflects the value of the agent, not the cost of keeping the lights on.
        </p>
      </section>

      {/* FAQ */}
      <section style={{ padding: "64px 0" }}>
        <h2 style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em", color: "var(--text-primary)", marginBottom: "40px" }}>
          Common questions
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "32px", maxWidth: "640px" }}>
          {[
            {
              q: "What does self-hosted actually cost?",
              a: "Vercel free tier handles most teams. Neon has a free Postgres tier. The main cost is AI tokens (Anthropic Claude). A typical team of 20 spending $50-100/month on tokens. That's it.",
            },
            {
              q: "Is the self-hosted version crippled?",
              a: "No. Same codebase, same tools, same everything. MIT license -- fork it, modify it, ship it.",
            },
            {
              q: "When is Aura Cloud launching?",
              a: "We're building it now. If you want early access, join the waitlist above.",
            },
            {
              q: "What's the catch?",
              a: "No catch. We're subsidized by RealAdvisor while we build the cloud product. Open source is the distribution strategy.",
            },
          ].map(({ q, a }) => (
            <div key={q}>
              <p style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px", fontSize: "0.95rem" }}>{q}</p>
              <p style={{ color: "var(--text-secondary)", lineHeight: 1.7, fontSize: "0.9rem" }}>{a}</p>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
}

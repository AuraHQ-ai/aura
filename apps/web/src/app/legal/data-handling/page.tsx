import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Data Handling — Aura",
  description:
    "How Aura handles your Slack workspace data, what we store, and how AI models are used.",
};

export default function DataHandlingPage() {
  const sectionStyle = {
    marginBottom: "48px",
  };

  const headingStyle = {
    fontSize: "1.25rem",
    fontWeight: 600 as const,
    color: "var(--text-primary)",
    marginBottom: "16px",
    letterSpacing: "-0.01em",
  };

  const paragraphStyle = {
    fontSize: "0.9375rem",
    color: "var(--text-secondary)",
    lineHeight: 1.75,
    marginBottom: "12px",
  };

  const listStyle = {
    paddingLeft: "1.5rem",
    marginBottom: "16px",
  };

  const listItemStyle = {
    fontSize: "0.9375rem",
    color: "var(--text-secondary)",
    lineHeight: 1.75,
    marginBottom: "8px",
  };

  return (
    <div className="site-inner" style={{ paddingTop: "64px", paddingBottom: "96px" }}>
      <div style={{ maxWidth: "640px" }}>
        <p
          style={{
            fontSize: "12px",
            fontWeight: 600,
            letterSpacing: "0.08em",
            color: "var(--text-muted)",
            textTransform: "uppercase",
            marginBottom: "16px",
          }}
        >
          Legal
        </p>
        <h1
          style={{
            fontSize: "clamp(1.75rem, 4vw, 2.5rem)",
            fontWeight: 700,
            letterSpacing: "-0.03em",
            lineHeight: 1.15,
            color: "var(--text-primary)",
            marginBottom: "16px",
          }}
        >
          Data Handling Policy
        </h1>
        <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "48px" }}>
          Last updated: March 2026
        </p>

        <div style={sectionStyle}>
          <h2 style={headingStyle}>Overview</h2>
          <p style={paragraphStyle}>
            Aura is an AI assistant that operates within your Slack workspace. This document explains
            what data Aura accesses, what it stores, how AI models are used, and your rights as a
            workspace administrator.
          </p>
        </div>

        <div style={sectionStyle}>
          <h2 style={headingStyle}>What data Aura accesses</h2>
          <p style={paragraphStyle}>
            When installed, Aura can read messages in Slack channels it has been invited to. Aura
            does not access private channels or DMs unless explicitly invited. The data Aura accesses
            includes:
          </p>
          <ul style={listStyle}>
            <li style={listItemStyle}>Messages in channels Aura is a member of</li>
            <li style={listItemStyle}>Thread replies in those channels</li>
            <li style={listItemStyle}>User display names and profile information (public)</li>
            <li style={listItemStyle}>Files shared in conversations where Aura is mentioned</li>
          </ul>
        </div>

        <div style={sectionStyle}>
          <h2 style={headingStyle}>What data Aura stores</h2>
          <p style={paragraphStyle}>
            Aura stores <strong style={{ color: "var(--text-primary)" }}>conversation summaries
            and structured notes</strong> — not raw message transcripts. Specifically:
          </p>
          <ul style={listStyle}>
            <li style={listItemStyle}>
              <strong style={{ color: "var(--text-primary)" }}>Summaries:</strong> Condensed
              versions of conversations, capturing key decisions, action items, and context.
            </li>
            <li style={listItemStyle}>
              <strong style={{ color: "var(--text-primary)" }}>Notes &amp; memory:</strong> Structured
              knowledge Aura builds over time about your team, projects, and processes.
            </li>
            <li style={listItemStyle}>
              <strong style={{ color: "var(--text-primary)" }}>Embeddings:</strong> Vector
              representations used for semantic search and retrieval. These are numerical
              representations, not human-readable text.
            </li>
          </ul>
          <p style={paragraphStyle}>
            Aura does <strong style={{ color: "var(--text-primary)" }}>not</strong> store full
            message transcripts, deleted messages, or message edit history.
          </p>
        </div>

        <div style={sectionStyle}>
          <h2 style={headingStyle}>AI model usage</h2>
          <p style={paragraphStyle}>
            Aura uses <strong style={{ color: "var(--text-primary)" }}>Anthropic Claude</strong> as
            its primary large language model (LLM). Here is how your data interacts with the model:
          </p>
          <ul style={listStyle}>
            <li style={listItemStyle}>
              Messages are sent to Anthropic&apos;s API for real-time processing (understanding
              context, generating responses, deciding actions).
            </li>
            <li style={listItemStyle}>
              <strong style={{ color: "var(--text-primary)" }}>Your data is never used to train
              or fine-tune AI models.</strong> Anthropic&apos;s commercial API terms prohibit using
              customer data for model training.
            </li>
            <li style={listItemStyle}>
              Conversations are processed in real-time and are not retained by Anthropic beyond
              the API request lifecycle (per Anthropic&apos;s data retention policy).
            </li>
            <li style={listItemStyle}>
              Aura identifies itself as an AI assistant. It does not impersonate humans.
            </li>
          </ul>
        </div>

        <div style={sectionStyle}>
          <h2 style={headingStyle}>Data security</h2>
          <ul style={listStyle}>
            <li style={listItemStyle}>All data is encrypted in transit (TLS) and at rest.</li>
            <li style={listItemStyle}>
              Aura&apos;s database is hosted on managed PostgreSQL infrastructure with automated
              backups and access controls.
            </li>
            <li style={listItemStyle}>
              API tokens and credentials are stored as encrypted environment variables, never in
              source code.
            </li>
          </ul>
        </div>

        <div style={sectionStyle}>
          <h2 style={headingStyle}>Your controls</h2>
          <ul style={listStyle}>
            <li style={listItemStyle}>
              <strong style={{ color: "var(--text-primary)" }}>Channel access:</strong> Aura only
              operates in channels it&apos;s invited to. Remove Aura from a channel at any time to
              stop access.
            </li>
            <li style={listItemStyle}>
              <strong style={{ color: "var(--text-primary)" }}>Uninstall:</strong> Workspace admins
              can uninstall Aura at any time from Slack&apos;s app management page.
            </li>
            <li style={listItemStyle}>
              <strong style={{ color: "var(--text-primary)" }}>Data deletion:</strong> Upon
              uninstallation, you can request deletion of all stored data by contacting us.
            </li>
          </ul>
        </div>

        <div style={sectionStyle}>
          <h2 style={headingStyle}>Third-party sub-processors</h2>
          <ul style={listStyle}>
            <li style={listItemStyle}><strong style={{ color: "var(--text-primary)" }}>Anthropic</strong> — LLM inference (Claude)</li>
            <li style={listItemStyle}><strong style={{ color: "var(--text-primary)" }}>Vercel</strong> — Application hosting and serverless compute</li>
            <li style={listItemStyle}><strong style={{ color: "var(--text-primary)" }}>PostgreSQL (managed)</strong> — Data storage</li>
          </ul>
        </div>

        <div style={{ borderTop: "1px solid var(--col-border)", paddingTop: "32px" }}>
          <h2 style={headingStyle}>Contact</h2>
          <p style={paragraphStyle}>
            For questions about data handling, privacy, or to request data deletion, contact us
            at{" "}
            <a
              href="mailto:hello@aurahq.ai"
              style={{
                color: "var(--text-primary)",
                textDecoration: "underline",
                textUnderlineOffset: "3px",
              }}
            >
              hello@aurahq.ai
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

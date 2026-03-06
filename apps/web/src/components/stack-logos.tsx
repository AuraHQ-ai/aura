// "Built with" logo strip
// To replace a logo: swap the file at /public/logos/<name>.svg
// href: internal blog post, or null for external homepage

import Link from "next/link";

type Logo = { name: string; file: string; width: number; href: string };

export const stackLogos: Logo[] = [
  // ── AI Models ──────────────────────────────────────────────
  { name: "Anthropic",   file: "anthropic",   width: 20, href: "/blog/what-we-stole-from-claude-cursor-openclaw" },
  { name: "OpenAI",      file: "openai",      width: 20, href: "/blog/what-we-stole-from-claude-cursor-openclaw" },
  { name: "xAI",         file: "xai",         width: 20, href: "/blog/what-we-stole-from-claude-cursor-openclaw" },
  // ── Infra ──────────────────────────────────────────────────
  { name: "Vercel",      file: "vercel",      width: 20, href: "/blog/the-only-tool-your-agent-needs" },
  { name: "Neon",        file: "neon",        width: 20, href: "/blog/why-neon-postgres" },
  // ── Comms ──────────────────────────────────────────────────
  { name: "Slack",       file: "slack",       width: 20, href: "/blog/building-on-slack-assistant-sdk" },
  // ── Voice / Search ─────────────────────────────────────────
  { name: "ElevenLabs",  file: "elevenlabs",  width: 20, href: "/blog/building-voice-agents-elevenlabs" },
  { name: "Google",      file: "google",      width: 20, href: "/blog/vector-search-cant-find-people" },
  // ── Dev tools ──────────────────────────────────────────────
  { name: "Cohere",      file: "cohere",      width: 64, href: "/blog/vector-search-cant-find-people" },
  { name: "Tavily",      file: "tavily",      width: 58, href: "/blog/the-only-tool-your-agent-needs" },
  { name: "E2B",         file: "e2b",         width: 36, href: "/blog/how-e2b-sandboxes-work" },
  { name: "Browserbase", file: "browserbase", width: 88, href: "/blog/why-browserbase" },
];

export function StackLogos() {
  return (
    <section
      style={{
        borderBottom: "1px solid var(--col-border)",
        padding: "32px 0",
      }}
    >
      <div className="container">
        <p
          style={{
            fontSize: "11px",
            fontWeight: 500,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
            marginBottom: "24px",
            textAlign: "center",
          }}
        >
          Built with the best stack in the game
        </p>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            alignItems: "center",
            gap: "32px",
          }}
        >
          {stackLogos.map((logo) => (
            <Link
              key={logo.name}
              href={logo.href}
              title={logo.name}
              style={{ opacity: 0.35, display: "block", transition: "opacity 0.15s" }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.opacity = "0.7")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.opacity = "0.35")}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/logos/${logo.file}.svg`}
                alt={logo.name}
                width={logo.width}
                height={20}
                style={{ display: "block" }}
              />
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

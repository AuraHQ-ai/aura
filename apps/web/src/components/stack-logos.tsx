// "Built with" logo strip
// To replace a logo: swap the file at /public/logos/<name>.svg

type Logo = { name: string; file: string; width: number };

export const stackLogos: Logo[] = [
  // ── AI Models ──────────────────────────────────────────────
  { name: "Anthropic",    file: "anthropic",    width: 20  },
  { name: "OpenAI",       file: "openai",       width: 20  },
  { name: "xAI",          file: "xai",          width: 20  },
  // ── Infra ──────────────────────────────────────────────────
  { name: "Vercel",       file: "vercel",       width: 20  },
  { name: "Neon",         file: "neon",         width: 20  },
  // ── Comms ──────────────────────────────────────────────────
  { name: "Slack",        file: "slack",        width: 20  },
  // ── Voice / Search ─────────────────────────────────────────
  { name: "ElevenLabs",   file: "elevenlabs",   width: 20  },
  { name: "Google",       file: "google",       width: 20  },
  // ── Dev tools ──────────────────────────────────────────────
  { name: "Cohere",       file: "cohere",       width: 64  },
  { name: "Tavily",       file: "tavily",       width: 58  },
  { name: "E2B",          file: "e2b",          width: 36  },
  { name: "Browserbase",  file: "browserbase",  width: 88  },
];

export function StackLogos() {
  return (
    <section
      style={{
        borderBottom: "1px solid var(--border)",
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
            color: "var(--muted)",
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
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={logo.name}
              src={`/logos/${logo.file}.svg`}
              alt={logo.name}
              width={logo.width}
              height={20}
              style={{ opacity: 0.35, display: "block" }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

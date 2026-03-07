import type { Metadata } from "next";
import Link from "next/link";
import { ThemeProvider } from "next-themes";
import { ThemeToggle } from "@/components/theme-toggle";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://aurahq.ai"),
  title: "Aura — Every day she works, she gets harder to replace",
  description:
    "An AI colleague with memory, autonomy, and a brain that builds itself. Not a chatbot. Not a wrapper. A mind that compounds.",
  openGraph: {
    title: "Aura — Every day she works, she gets harder to replace",
    description:
      "An AI colleague with memory, autonomy, and a brain that builds itself.",
    url: "https://aurahq.ai",
    siteName: "Aura",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Aura — Every day she works, she gets harder to replace",
    description:
      "An AI colleague with memory, autonomy, and a brain that builds itself.",
  },
  alternates: {
    types: {
      "application/rss+xml": "/blog/feed.xml",
    },
  },
};

function Nav() {
  return (
    <nav
      className="nav-bg"
      style={{
        borderBottom: "1px solid var(--col-border)",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      <div className="layout-inner nav-inner">
        <Link
          href="/"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontWeight: 600,
            fontSize: "14px",
            letterSpacing: "-0.01em",
            color: "var(--text-primary)",
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="16"
            viewBox="0 0 102 90"
            fill="none"
            className="text-black dark:text-white"
            style={{ flexShrink: 0 }}
          >
            <path
              fill="currentColor"
              d="m58 0 44 77-8 13H7L0 77 43 0h15ZM6 77l3 5 36-64 9 16 17 30h6L45 8 6 77Zm79-8H34l-3 5h64L55 5h-6l36 64Zm-48-5h28L51 39 37 64Z"
            />
          </svg>
          <span style={{ position: "relative", display: "flex", width: "8px", height: "8px" }}>
            <span
              style={{
                position: "absolute",
                display: "inline-flex",
                width: "100%",
                height: "100%",
                borderRadius: "50%",
                background: "#22c55e",
                opacity: 0.6,
                animation: "ping 1.5s cubic-bezier(0,0,0.2,1) infinite",
              }}
            />
            <span
              style={{
                position: "relative",
                display: "inline-flex",
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: "#22c55e",
              }}
            />
          </span>
          Aura
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: "28px" }}>
          <Link href="/blog" style={{ fontSize: "14px", color: "var(--text-secondary)" }}>Blog</Link>
          <a href="https://docs.aurahq.ai" style={{ fontSize: "14px", color: "var(--text-secondary)" }}>Docs</a>
          <a
            href="https://github.com/AuraHQ-ai/aura"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: "13px",
              fontWeight: 500,
              background: "var(--btn-bg)",
              color: "var(--btn-color)",
              padding: "6px 16px",
              borderRadius: "6px",
              letterSpacing: "-0.01em",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              textDecoration: "none",
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style={{ width: "14px", height: "14px", flexShrink: 0 }}>
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            Star on GitHub
          </a>
        </div>
      </div>
      <style>{`
        @keyframes ping {
          75%, 100% { transform: scale(2); opacity: 0; }
        }
      `}</style>
    </nav>
  );
}

function Footer() {
  return (
    <footer style={{ borderTop: "1px solid var(--col-border)" }}>
      <div
        className="layout-inner footer-inner"
      >
        <div style={{ display: "flex", alignItems: "center", gap: "24px" }}>
          <Link href="/" style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>Aura</Link>
          <Link href="/blog" style={{ fontSize: "13px", color: "var(--text-muted)" }}>Blog</Link>
          <a href="https://docs.aurahq.ai" style={{ fontSize: "13px", color: "var(--text-muted)" }}>Docs</a>
          <a href="/blog/feed.xml" style={{ fontSize: "13px", color: "var(--text-muted)" }}>RSS</a>
          <a href="/llms.txt" style={{ fontSize: "13px", color: "var(--text-muted)" }}>llms.txt</a>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <ThemeToggle />
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>Built by RealAdvisor</span>
          <a
            href="https://github.com/AuraHQ-ai/aura"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--text-muted)" }}
            aria-label="View source on GitHub"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style={{ width: "15px", height: "15px" }}>
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
          </a>
          <a
            href="https://x.com/aurahq_ai"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--text-muted)" }}
            aria-label="Follow on X"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style={{ width: "15px", height: "15px" }}>
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
        </div>
      </div>
    </footer>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <Nav />
          <main className="site-main">
            {children}
          </main>
          <Footer />
        </ThemeProvider>
      </body>
    </html>
  );
}

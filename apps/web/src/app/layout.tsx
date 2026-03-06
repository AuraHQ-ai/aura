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
            href="mailto:hello@aurahq.ai"
            style={{
              fontSize: "13px",
              fontWeight: 500,
              background: "var(--btn-bg)",
              color: "var(--btn-color)",
              padding: "6px 16px",
              borderRadius: "6px",
              letterSpacing: "-0.01em",
            }}
          >
            Get access
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

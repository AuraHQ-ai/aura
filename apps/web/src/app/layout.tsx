import type { Metadata } from "next";
import Link from "next/link";
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-black text-white antialiased">
        <div className="min-h-screen">
          <header className="border-b border-white/10 bg-black/70 backdrop-blur">
            <nav className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
              <Link href="/" className="text-sm font-semibold tracking-wide text-white">
                Aura
              </Link>
              <div className="flex items-center gap-5 text-sm text-neutral-400">
                <Link href="/blog" className="transition hover:text-white">
                  Blog
                </Link>
                <a
                  href="https://docs.aurahq.ai"
                  target="_blank"
                  rel="noreferrer"
                  className="transition hover:text-white"
                >
                  Docs
                </a>
                <a
                  href="https://api.aurahq.ai"
                  target="_blank"
                  rel="noreferrer"
                  className="transition hover:text-white"
                >
                  API
                </a>
              </div>
            </nav>
          </header>
          {children}
          <footer className="border-t border-white/10 px-6 py-8">
            <div className="mx-auto flex w-full max-w-5xl items-center justify-between text-sm text-neutral-500">
              <span>Aura — aurahq.ai</span>
              <span>Built by RealAdvisor</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}

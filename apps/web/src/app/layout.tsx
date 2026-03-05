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

function Nav() {
  return (
    <nav className="fixed top-0 z-50 w-full border-b border-neutral-800/50 bg-black/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-wide">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
          </span>
          Aura
        </Link>
        <div className="flex items-center gap-6">
          <Link
            href="/blog"
            className="text-sm text-neutral-400 transition hover:text-white"
          >
            Blog
          </Link>
          <a
            href="https://docs.aurahq.ai"
            className="text-sm text-neutral-400 transition hover:text-white"
          >
            Docs
          </a>
          <a
            href="/#waitlist"
            className="rounded-full bg-white px-4 py-1.5 text-sm font-medium text-black transition hover:bg-neutral-200"
          >
            Get access
          </a>
        </div>
      </div>
    </nav>
  );
}

function Footer() {
  return (
    <footer className="border-t border-neutral-800 px-6 py-12">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 sm:flex-row">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-sm font-semibold">
            Aura
          </Link>
          <Link
            href="/blog"
            className="text-sm text-neutral-500 transition hover:text-white"
          >
            Blog
          </Link>
          <a
            href="https://docs.aurahq.ai"
            className="text-sm text-neutral-500 transition hover:text-white"
          >
            Docs
          </a>
          <a
            href="/blog/feed.xml"
            className="text-sm text-neutral-500 transition hover:text-white"
          >
            RSS
          </a>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs text-neutral-700">
            Built by RealAdvisor
          </span>
          <a
            href="https://x.com/aurahq_ai"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-600 transition hover:text-white"
            aria-label="Follow on X"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
        </div>
      </div>
    </footer>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-black text-white antialiased">
        <Nav />
        <div className="pt-16">{children}</div>
        <Footer />
      </body>
    </html>
  );
}

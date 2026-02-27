import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
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
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-black text-white antialiased">{children}</body>
    </html>
  );
}

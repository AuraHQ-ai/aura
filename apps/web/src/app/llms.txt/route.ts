import { getAllPosts } from "@/lib/blog";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const posts = (await getAllPosts()).filter((p) => !p.draft);

  const blogLines = posts
    .map(
      (p) =>
        `- [${p.title}](https://aurahq.ai/blog/${p.slug}): ${p.excerpt || ""}`
    )
    .join("\n");

  const docs = [
    { title: "Getting Started", path: "getting-started", desc: "Deploy Aura into your Slack workspace in under 15 minutes." },
    { title: "Architecture", path: "architecture", desc: "How Aura's message pipeline, memory system, tools, and self-improvement loop work." },
    { title: "Memory System", path: "memory-system", desc: "How Aura stores, retrieves, consolidates, and connects knowledge over time." },
    { title: "Self-Improvement", path: "self-improvement", desc: "How Aura identifies gaps, files issues, and opens PRs against her own codebase." },
    { title: "Sandbox (E2B)", path: "tools/sandbox", desc: "Isolated Linux VM for running arbitrary code, scripts, and development tools." },
    { title: "Slack Tools", path: "tools/slack", desc: "How Aura interacts with Slack -- messaging, search, channels, and streaming." },
    { title: "Email Tools", path: "tools/email", desc: "Gmail integration for reading, searching, and composing email." },
    { title: "BigQuery Tools", path: "tools/bigquery", desc: "How Aura queries your data warehouse and turns results into insights." },
    { title: "Vercel Deployment", path: "deployment/vercel", desc: "How Aura runs on Vercel serverless functions with automatic deploys from main." },
    { title: "Environment Variables", path: "deployment/environment-variables", desc: "Complete list of environment variables for configuring Aura." },
    { title: "API Reference", path: "api-reference/overview", desc: "Aura's HTTP endpoints for Slack events, health checks, and cron jobs." },
  ];

  const docsLines = docs
    .map((d) => `- [${d.title}](https://aurahq.ai/docs/${d.path}): ${d.desc}`)
    .join("\n");

  const llmstxt = `# Aura

> An AI colleague that lives in Slack -- with persistent memory, autonomous background work, and a codebase that evolves itself.

Aura is not a chatbot or a search bar. She is a deployed team member: she remembers everything she has learned, works while her team sleeps, and gets harder to replace every day she is active. Built on Vercel, Neon Postgres, E2B sandboxes, and the Slack Assistant SDK -- all open-source and self-hostable.

## What Aura does

- Reads and posts in Slack channels, sends DMs, manages threads
- Runs SQL against BigQuery and returns business insights
- Reads and drafts email via Gmail API
- Makes outbound phone calls via ElevenLabs + Twilio
- Executes code in persistent E2B Linux sandboxes
- Browses the web using Browserbase (stealth Chromium)
- Schedules and runs background jobs (cron + one-shot)
- Stores memories in Postgres with pgvector -- 23,000+ facts and growing
- Opens PRs against its own GitHub repo to evolve its own behavior

## Open source

GitHub: https://github.com/realadvisor/aura
License: MIT

## Blog

${blogLines}

## Docs

${docsLines}

## Get access

https://aurahq.ai#waitlist
`;

  return new NextResponse(llmstxt, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

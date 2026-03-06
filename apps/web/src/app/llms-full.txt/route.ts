import { getAllPosts, getPostBySlug } from "@/lib/blog";
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

function readDocsDir(dir: string, prefix = ""): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...readDocsDir(fullPath, `${prefix}${entry}/`));
      } else if (entry.endsWith(".mdx")) {
        const slug = `${prefix}${entry.replace(".mdx", "")}`;
        const content = fs.readFileSync(fullPath, "utf-8").replace(/^---\n[\s\S]*?\n---\n/, "");
        results.push(
          `## Docs: ${slug}\nURL: https://aurahq.ai/docs/${slug}\n\n${content}\n\n---`
        );
      }
    }
  } catch {
    // docs dir not available at build time
  }
  return results;
}

export async function GET() {
  const posts = (await getAllPosts()).filter((p) => !p.draft);
  const sections: string[] = [];

  sections.push(`# Aura -- Full Content

> An AI colleague that lives in Slack -- with persistent memory, autonomous background work, and a codebase that evolves itself.

Source: https://aurahq.ai
GitHub: https://github.com/realadvisor/aura

---`);

  sections.push("# Blog Posts\n");
  for (const post of posts) {
    const full = await getPostBySlug(post.slug);
    if (!full) continue;
    sections.push(
      `## ${post.title}\nURL: https://aurahq.ai/blog/${post.slug}\nDate: ${post.date}\n\n${full.content}\n\n---`
    );
  }

  sections.push("# Documentation\n");
  const docsDir = path.join(process.cwd(), "content/docs");
  sections.push(...readDocsDir(docsDir));

  return new NextResponse(sections.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

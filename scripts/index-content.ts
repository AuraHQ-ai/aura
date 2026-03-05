/**
 * Content indexing pipeline.
 *
 * Reads MDX frontmatter from content/blog/, computes reading time and
 * embeddings, and upserts into the `content` table in Postgres.
 *
 * Usage:
 *   npx tsx scripts/index-content.ts
 *
 * Requires: DATABASE_URL, OPENAI_API_KEY (or AI_GATEWAY_URL + ANTHROPIC_API_KEY)
 */

import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { neon } from "@neondatabase/serverless";

const CONTENT_DIR = path.join(process.cwd(), "content", "blog");

interface ContentEntry {
  slug: string;
  type: string;
  title: string;
  excerpt: string | null;
  author: string | null;
  tags: string[];
  publishedAt: string | null;
  readingMinutes: number;
  ogImage: string | null;
  rawPath: string;
}

function estimateReadingMinutes(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 250));
}

function scanBlogPosts(): ContentEntry[] {
  if (!fs.existsSync(CONTENT_DIR)) {
    console.log("No content/blog directory found, skipping.");
    return [];
  }

  const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".mdx"));
  const entries: ContentEntry[] = [];

  for (const file of files) {
    const filePath = path.join(CONTENT_DIR, file);
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);

    if (data.draft) continue;

    const slug = data.slug || path.basename(file, ".mdx");

    entries.push({
      slug,
      type: "blog",
      title: data.title ?? "Untitled",
      excerpt: data.excerpt ?? null,
      author: data.author ?? null,
      tags: data.tags ?? [],
      publishedAt: data.date ? new Date(data.date).toISOString() : null,
      readingMinutes: estimateReadingMinutes(content),
      ogImage: data.og_image ?? null,
      rawPath: `content/blog/${file}`,
    });
  }

  return entries;
}

async function generateEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("No OPENAI_API_KEY — skipping embedding generation.");
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-large",
      input: text,
      dimensions: 1536,
    }),
  });

  if (!response.ok) {
    console.error("Embedding API error:", response.status, await response.text());
    return null;
  }

  const json = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return json.data[0].embedding;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const sql = neon(databaseUrl);

  await sql`
    CREATE TABLE IF NOT EXISTS content (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      excerpt TEXT,
      author TEXT,
      tags TEXT[],
      published_at TIMESTAMPTZ,
      reading_minutes INT,
      og_image TEXT,
      embedding vector(1536),
      raw_path TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  const entries = scanBlogPosts();
  console.log(`Found ${entries.length} blog post(s) to index.`);

  for (const entry of entries) {
    const embeddingText = `${entry.title}. ${entry.excerpt ?? ""}`;
    const embedding = await generateEmbedding(embeddingText);

    const embeddingValue = embedding ? JSON.stringify(embedding) : null;

    await sql`
      INSERT INTO content (slug, type, title, excerpt, author, tags, published_at, reading_minutes, og_image, embedding, raw_path, updated_at)
      VALUES (
        ${entry.slug},
        ${entry.type},
        ${entry.title},
        ${entry.excerpt},
        ${entry.author},
        ${entry.tags},
        ${entry.publishedAt},
        ${entry.readingMinutes},
        ${entry.ogImage},
        ${embeddingValue}::vector,
        ${entry.rawPath},
        NOW()
      )
      ON CONFLICT (slug) DO UPDATE SET
        type = EXCLUDED.type,
        title = EXCLUDED.title,
        excerpt = EXCLUDED.excerpt,
        author = EXCLUDED.author,
        tags = EXCLUDED.tags,
        published_at = EXCLUDED.published_at,
        reading_minutes = EXCLUDED.reading_minutes,
        og_image = EXCLUDED.og_image,
        embedding = EXCLUDED.embedding,
        raw_path = EXCLUDED.raw_path,
        updated_at = NOW()
    `;

    console.log(`  ✓ ${entry.slug}`);
  }

  console.log("Content indexing complete.");
}

main().catch((err) => {
  console.error("Content indexing failed:", err);
  process.exit(1);
});

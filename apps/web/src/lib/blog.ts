import fs from "fs";
import path from "path";
import matter from "gray-matter";
import readingTime from "reading-time";

const CONTENT_DIR = path.join(process.cwd(), "..", "..", "content", "blog");

export interface BlogPost {
  slug: string;
  title: string;
  date: string;
  author: string;
  tags: string[];
  excerpt: string;
  ogImage?: string;
  readingTime: string;
  content: string;
}

export interface BlogPostMeta {
  slug: string;
  title: string;
  date: string;
  author: string;
  tags: string[];
  excerpt: string;
  ogImage?: string;
  readingTime: string;
}

function parseMdxFile(filePath: string): BlogPost | null {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);

  if (data.draft) return null;

  const slug =
    data.slug || path.basename(filePath, path.extname(filePath));
  const stats = readingTime(content);

  return {
    slug,
    title: data.title ?? "Untitled",
    date: data.date ? new Date(data.date).toISOString() : new Date().toISOString(),
    author: data.author ?? "aura",
    tags: data.tags ?? [],
    excerpt: data.excerpt ?? "",
    ogImage: data.og_image,
    readingTime: stats.text,
    content,
  };
}

export function getAllPosts(): BlogPostMeta[] {
  if (!fs.existsSync(CONTENT_DIR)) return [];

  const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".mdx"));
  const posts: BlogPostMeta[] = [];

  for (const file of files) {
    const post = parseMdxFile(path.join(CONTENT_DIR, file));
    if (!post) continue;
    const { content: _, ...meta } = post;
    posts.push(meta);
  }

  return posts.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
}

export function getPostBySlug(slug: string): BlogPost | null {
  if (!fs.existsSync(CONTENT_DIR)) return null;

  const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".mdx"));

  for (const file of files) {
    const post = parseMdxFile(path.join(CONTENT_DIR, file));
    if (post && post.slug === slug) return post;
  }

  return null;
}

export function getAllSlugs(): string[] {
  if (!fs.existsSync(CONTENT_DIR)) return [];

  const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".mdx"));
  const slugs: string[] = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(CONTENT_DIR, file), "utf-8");
    const { data } = matter(raw);
    if (data.draft) continue;
    slugs.push(data.slug || path.basename(file, ".mdx"));
  }

  return slugs;
}

export function getPostsByTag(tag: string): BlogPostMeta[] {
  return getAllPosts().filter((p) => p.tags.includes(tag));
}

export function getAllTags(): string[] {
  const tags = new Set<string>();
  for (const post of getAllPosts()) {
    for (const tag of post.tags) tags.add(tag);
  }
  return Array.from(tags).sort();
}

export function getRelatedPosts(
  slug: string,
  limit = 3
): BlogPostMeta[] {
  const current = getAllPosts().find((p) => p.slug === slug);
  if (!current) return [];

  const others = getAllPosts().filter((p) => p.slug !== slug);
  const scored = others.map((post) => {
    const overlap = post.tags.filter((t) => current.tags.includes(t)).length;
    return { post, score: overlap };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((s) => s.score > 0)
    .map((s) => s.post);
}

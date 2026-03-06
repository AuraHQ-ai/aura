import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import readingTime from "reading-time";

type Frontmatter = {
  title?: string;
  slug?: string;
  date?: string | Date;
  author?: string;
  tags?: string[];
  excerpt?: string;
  og_image?: string;
  draft?: boolean;
};

export interface BlogPostMeta {
  slug: string;
  title: string;
  date: string;
  author: string;
  tags: string[];
  excerpt: string;
  ogImage?: string;
  readingMinutes: number;
  draft?: boolean;
}

export interface BlogPost extends BlogPostMeta {
  content: string;
}

const BLOG_ROOT = path.resolve(process.cwd(), "..", "..", "content", "blog");

export function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

async function listMdxFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return listMdxFiles(fullPath);
      return fullPath.endsWith(".mdx") || fullPath.endsWith(".md")
        ? [fullPath]
        : [];
    }),
  );
  return files.flat();
}

function normalizeDate(value: string | Date | undefined): string {
  if (!value) return new Date(0).toISOString();
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function parsePost(filePath: string, raw: string): BlogPost | null {
  const { data, content } = matter(raw);
  const fm = data as Frontmatter;

  if (fm.draft) return null;

  const slug = fm.slug ?? path.basename(filePath, path.extname(filePath));
  const stats = readingTime(content);

  return {
    slug,
    title: fm.title ?? slug,
    date: normalizeDate(fm.date),
    author: fm.author ?? "aura",
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    excerpt: fm.excerpt ?? "",
    ogImage: fm.og_image,
    readingMinutes: Math.max(1, Math.ceil(stats.minutes)),
    content,
  };
}

export async function getAllPosts(): Promise<BlogPostMeta[]> {
  const files = await listMdxFiles(BLOG_ROOT);
  const posts: BlogPostMeta[] = [];

  for (const filePath of files) {
    const raw = await readFile(filePath, "utf-8");
    const post = parsePost(filePath, raw);
    if (!post) continue;
    const { content: _, ...meta } = post;
    posts.push(meta);
  }

  return posts.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
}

export async function getPostBySlug(slug: string): Promise<BlogPost | null> {
  const files = await listMdxFiles(BLOG_ROOT);

  for (const filePath of files) {
    const raw = await readFile(filePath, "utf-8");
    const post = parsePost(filePath, raw);
    if (post && post.slug === slug) return post;
  }

  return null;
}

export async function getAllSlugs(): Promise<string[]> {
  const posts = await getAllPosts();
  return posts.map((p) => p.slug);
}

export async function getAllTags(): Promise<string[]> {
  const posts = await getAllPosts();
  return Array.from(new Set(posts.flatMap((p) => p.tags))).sort();
}

export async function getRelatedPosts(
  slug: string,
  tags: string[],
  limit = 3,
): Promise<BlogPostMeta[]> {
  if (tags.length === 0) return [];
  const posts = await getAllPosts();

  return posts
    .filter((p) => p.slug !== slug)
    .map((post) => ({
      post,
      overlap: post.tags.filter((t) => tags.includes(t)).length,
    }))
    .filter(({ overlap }) => overlap > 0)
    .sort(
      (a, b) =>
        b.overlap - a.overlap ||
        new Date(b.post.date).getTime() - new Date(a.post.date).getTime(),
    )
    .slice(0, limit)
    .map(({ post }) => post);
}

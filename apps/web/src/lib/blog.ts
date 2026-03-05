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
};

export interface BlogPostMeta {
  title: string;
  slug: string;
  date: string;
  author: string;
  tags: string[];
  excerpt: string;
  ogImage?: string;
  readingMinutes: number;
  rawPath: string;
}

export interface BlogPost extends BlogPostMeta {
  content: string;
}

const BLOG_ROOT = path.resolve(process.cwd(), "..", "..", "content", "blog");

async function listMdxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listMdxFiles(fullPath);
      }
      return fullPath.endsWith(".mdx") || fullPath.endsWith(".md")
        ? [fullPath]
        : [];
    }),
  );
  return files.flat();
}

function normalizeDate(dateValue: string | Date | undefined): string {
  if (!dateValue) return new Date(0).toISOString();
  const parsed = dateValue instanceof Date ? dateValue : new Date(dateValue);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function parseFileToPost(filePath: string, file: string): BlogPost {
  const { data, content } = matter(file);
  const fm = data as Frontmatter;
  const slug = fm.slug ?? path.basename(filePath, path.extname(filePath));
  const read = readingTime(content);
  return {
    title: fm.title ?? slug,
    slug,
    date: normalizeDate(fm.date),
    author: fm.author ?? "aura",
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    excerpt: fm.excerpt ?? "",
    ogImage: fm.og_image,
    readingMinutes: Math.max(1, Math.ceil(read.minutes)),
    rawPath: path.relative(path.resolve(process.cwd(), "..", ".."), filePath),
    content,
  };
}

let _cachedPosts: BlogPost[] | null = null;

async function loadAllPosts(): Promise<BlogPost[]> {
  if (!_cachedPosts) {
    const files = await listMdxFiles(BLOG_ROOT);
    const posts = await Promise.all(
      files.map(async (filePath) => {
        const file = await readFile(filePath, "utf8");
        return parseFileToPost(filePath, file);
      }),
    );
    _cachedPosts = posts.sort((a, b) => +new Date(b.date) - +new Date(a.date));
  }
  return _cachedPosts;
}

export async function getAllBlogPosts(): Promise<BlogPostMeta[]> {
  const posts = await loadAllPosts();
  return posts.map(({ content: _content, ...meta }) => meta);
}

export async function getBlogPostBySlug(slug: string): Promise<BlogPost | null> {
  const posts = await loadAllPosts();
  return posts.find((post) => post.slug === slug) ?? null;
}

export async function getAllBlogTags(): Promise<string[]> {
  const posts = await getAllBlogPosts();
  return Array.from(new Set(posts.flatMap((post) => post.tags))).sort((a, b) =>
    a.localeCompare(b),
  );
}

export async function getRelatedPosts(
  slug: string,
  limit = 3,
): Promise<BlogPostMeta[]> {
  const posts = await getAllBlogPosts();
  const current = posts.find((post) => post.slug === slug);
  if (!current) return [];

  return posts
    .filter((post) => post.slug !== slug)
    .map((post) => ({
      post,
      overlap: post.tags.filter((tag) => current.tags.includes(tag)).length,
    }))
    .filter(({ overlap }) => overlap > 0)
    .sort(
      (a, b) =>
        b.overlap - a.overlap || +new Date(b.post.date) - +new Date(a.post.date),
    )
    .slice(0, limit)
    .map(({ post }) => post);
}

export function formatDate(
  value: string,
  monthFormat: "long" | "short" = "long",
): string {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: monthFormat,
    day: "numeric",
  });
}

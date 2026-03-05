import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import readingTime from "reading-time";
import { sql } from "drizzle-orm";

type ContentType = "blog" | "doc" | "landing";

type Frontmatter = {
  title?: string;
  slug?: string;
  date?: string | Date;
  author?: string;
  tags?: string[];
  excerpt?: string;
  description?: string;
  og_image?: string;
};

interface ContentRecord {
  slug: string;
  type: ContentType;
  title: string;
  excerpt: string | null;
  author: string | null;
  tags: string[];
  publishedAt: Date | null;
  readingMinutes: number;
  ogImage: string | null;
  rawPath: string;
  embeddingText: string;
}

const ROOT = process.cwd();
const CONTENT_ROOT = path.join(ROOT, "content");
const TARGETS = [
  { type: "blog" as const, dir: path.join(CONTENT_ROOT, "blog") },
  { type: "doc" as const, dir: path.join(CONTENT_ROOT, "docs") },
  { type: "landing" as const, dir: path.join(CONTENT_ROOT, "landing") },
];

function toPublishedAt(value: string | Date | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function deriveSlug(frontmatterSlug: string | undefined, filePath: string): string {
  if (frontmatterSlug) return frontmatterSlug;
  return filePath.replace(/\.(md|mdx)$/i, "");
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listMarkdownFiles(fullPath);
      }
      return fullPath.endsWith(".mdx") || fullPath.endsWith(".md")
        ? [fullPath]
        : [];
    }),
  );

  return files.flat();
}

async function readRecordsForType(
  type: ContentType,
  dir: string,
): Promise<ContentRecord[]> {
  const files = await listMarkdownFiles(dir);
  const records = await Promise.all(
    files.map(async (absolutePath) => {
      const file = await readFile(absolutePath, "utf8");
      const parsed = matter(file);
      const frontmatter = parsed.data as Frontmatter;
      const relativeFromContent = path
        .relative(CONTENT_ROOT, absolutePath)
        .split(path.sep)
        .join("/");
      const relativeWithoutExt = relativeFromContent.replace(/\.(md|mdx)$/i, "");
      const excerpt = frontmatter.excerpt ?? frontmatter.description ?? null;
      const bodyRead = readingTime(parsed.content);
      const slug = deriveSlug(frontmatter.slug, relativeWithoutExt);

      return {
        slug,
        type,
        title: frontmatter.title ?? slug,
        excerpt,
        author: frontmatter.author ?? null,
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
        publishedAt: toPublishedAt(frontmatter.date),
        readingMinutes: Math.max(1, Math.ceil(bodyRead.minutes)),
        ogImage: frontmatter.og_image ?? null,
        rawPath: `content/${relativeFromContent}`,
        embeddingText: `${frontmatter.title ?? slug}\n\n${excerpt ?? ""}\n\n${parsed.content.slice(0, 1500)}`,
      };
    }),
  );

  return records;
}

async function buildRecords(): Promise<ContentRecord[]> {
  const all = await Promise.all(
    TARGETS.map((target) => readRecordsForType(target.type, target.dir)),
  );
  return all.flat();
}

async function maybeGenerateEmbeddings(
  records: ContentRecord[],
  skipEmbeddings: boolean,
): Promise<Array<number[] | null>> {
  if (skipEmbeddings || records.length === 0) {
    return records.map(() => null);
  }

  try {
    const { embedTexts } = await import("../src/lib/embeddings.js");
    return await embedTexts(records.map((record) => record.embeddingText));
  } catch (error) {
    console.warn(
      "Embedding generation failed, continuing without embeddings:",
      String(error),
    );
    return records.map(() => null);
  }
}

async function upsertRecords(
  records: ContentRecord[],
  embeddings: Array<number[] | null>,
) {
  const [{ db }, { content }] = await Promise.all([
    import("../src/db/client.js"),
    import("../src/db/schema.js"),
  ]);

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const embedding = embeddings[i] ?? null;

    await db
      .insert(content)
      .values({
        slug: record.slug,
        type: record.type,
        title: record.title,
        excerpt: record.excerpt,
        author: record.author,
        tags: record.tags,
        publishedAt: record.publishedAt,
        readingMinutes: record.readingMinutes,
        ogImage: record.ogImage,
        embedding,
        rawPath: record.rawPath,
      })
      .onConflictDoUpdate({
        target: content.slug,
        set: {
          type: record.type,
          title: record.title,
          excerpt: record.excerpt,
          author: record.author,
          tags: record.tags,
          publishedAt: record.publishedAt,
          readingMinutes: record.readingMinutes,
          ogImage: record.ogImage,
          embedding,
          rawPath: record.rawPath,
          updatedAt: sql`now()`,
        },
      });
  }
}

async function main() {
  const skipEmbeddings = process.argv.includes("--skip-embeddings");

  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL not set, skipping content indexing.");
    return;
  }

  const records = await buildRecords();
  if (records.length === 0) {
    console.log("No markdown/MDX content found, skipping.");
    return;
  }

  const embeddings = await maybeGenerateEmbeddings(records, skipEmbeddings);
  await upsertRecords(records, embeddings);

  console.log(
    `Indexed ${records.length} content documents (${skipEmbeddings ? "without" : "with"} embeddings).`,
  );
}

main().catch((error) => {
  console.error("Content indexing failed:", error);
  process.exit(1);
});

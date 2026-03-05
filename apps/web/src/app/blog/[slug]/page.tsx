import { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { MDXRemote } from "next-mdx-remote/rsc";
import { getAllSlugs, getPostBySlug, getRelatedPosts } from "@/lib/blog";
import { mdxComponents } from "@/components/mdx-components";
import { createHighlighter } from "shiki";

let highlighterPromise: ReturnType<typeof createHighlighter> | null = null;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark"],
      langs: [
        "typescript",
        "javascript",
        "sql",
        "bash",
        "json",
        "yaml",
        "python",
        "tsx",
        "jsx",
        "markdown",
        "diff",
      ],
    });
  }
  return highlighterPromise;
}

export async function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) return {};

  return {
    title: `${post.title} — Aura`,
    description: post.excerpt,
    openGraph: {
      title: post.title,
      description: post.excerpt,
      type: "article",
      publishedTime: post.date,
      authors: [post.author],
      tags: post.tags,
      url: `https://aurahq.ai/blog/${post.slug}`,
      siteName: "Aura",
      ...(post.ogImage && { images: [post.ogImage] }),
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.excerpt,
    },
  };
}

export default async function BlogPost({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) notFound();

  const related = getRelatedPosts(slug, 3);
  const highlighter = await getHighlighter();

  return (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <article>
        <header className="mb-12">
          <div className="mb-4 flex items-center gap-3 text-sm text-neutral-500">
            <Link
              href="/blog"
              className="transition hover:text-white"
            >
              Blog
            </Link>
            <span className="text-neutral-700">/</span>
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {post.title}
          </h1>
          <div className="mt-4 flex items-center gap-4 text-sm text-neutral-500">
            <time dateTime={post.date}>
              {new Date(post.date).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </time>
            <span className="text-neutral-700">·</span>
            <span>{post.readingTime}</span>
            <span className="text-neutral-700">·</span>
            <span className="capitalize">{post.author}</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {post.tags.map((tag) => (
              <Link
                key={tag}
                href={`/blog?tag=${tag}`}
                className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-500 transition hover:text-neutral-300"
              >
                {tag}
              </Link>
            ))}
          </div>
        </header>

        <div className="prose prose-invert prose-neutral max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-p:text-neutral-300 prose-p:leading-relaxed prose-strong:text-white prose-pre:bg-neutral-900 prose-pre:border prose-pre:border-neutral-800">
          <MDXRemote
            source={post.content}
            components={mdxComponents}
            options={{
              mdxOptions: {
                rehypePlugins: [
                  [
                    (await import("rehype-pretty-code")).default,
                    {
                      getHighlighter: () => highlighter,
                      theme: "github-dark",
                      keepBackground: false,
                    },
                  ],
                ],
              },
            }}
          />
        </div>
      </article>

      {related.length > 0 && (
        <aside className="mt-24 border-t border-neutral-800 pt-12">
          <h2 className="mb-8 text-xl font-semibold">Related posts</h2>
          <div className="space-y-6">
            {related.map((r) => (
              <Link
                key={r.slug}
                href={`/blog/${r.slug}`}
                className="group block"
              >
                <h3 className="font-medium transition group-hover:text-neutral-300">
                  {r.title}
                </h3>
                <p className="mt-1 text-sm text-neutral-500">
                  {r.excerpt}
                </p>
              </Link>
            ))}
          </div>
        </aside>
      )}

      <div className="mt-16 border-t border-neutral-800 pt-8">
        <Link
          href="/blog"
          className="text-sm text-neutral-500 transition hover:text-white"
        >
          &larr; Back to all posts
        </Link>
      </div>
    </main>
  );
}

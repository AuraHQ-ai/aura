import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAllSlugs, getPostBySlug, getRelatedPosts } from "@/lib/blog";
import { renderMdx } from "@/lib/mdx";

type Props = {
  params: Promise<{ slug: string }>;
};

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export async function generateStaticParams() {
  const slugs = await getAllSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
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
      ...(post.ogImage && { images: [{ url: post.ogImage }] }),
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.excerpt,
      ...(post.ogImage && { images: [post.ogImage] }),
    },
  };
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) notFound();

  const [content, related] = await Promise.all([
    renderMdx(post.content),
    getRelatedPosts(post.slug),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <article>
        <header className="mb-12">
          <div className="mb-4 flex items-center gap-3 text-sm text-neutral-500">
            <Link href="/blog" className="transition hover:text-white">
              Blog
            </Link>
            <span className="text-neutral-700">/</span>
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {post.title}
          </h1>
          <p className="mt-4 text-lg text-neutral-300">{post.excerpt}</p>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-neutral-500">
            <time dateTime={post.date}>{formatDate(post.date)}</time>
            <span className="text-neutral-700">&middot;</span>
            <span>{post.readingMinutes} min read</span>
            <span className="text-neutral-700">&middot;</span>
            <span className="capitalize">{post.author}</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {post.tags.map((tag) => (
              <Link
                key={tag}
                href={`/blog?tag=${encodeURIComponent(tag)}`}
                className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-500 transition hover:text-neutral-300"
              >
                {tag}
              </Link>
            ))}
          </div>
        </header>

        <div className="prose prose-invert prose-neutral max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-p:text-neutral-300 prose-p:leading-relaxed prose-strong:text-white prose-pre:bg-neutral-900 prose-pre:border prose-pre:border-neutral-800">
          {content}
        </div>
      </article>

      {related.length > 0 && (
        <aside className="mt-24 border-t border-neutral-800 pt-12">
          <h2 className="mb-8 text-xl font-semibold">Related posts</h2>
          <div className="space-y-4">
            {related.map((r) => (
              <Link
                key={r.slug}
                href={`/blog/${r.slug}`}
                className="group block rounded-xl border border-neutral-800 p-4 transition hover:border-neutral-700"
              >
                <h3 className="font-medium transition group-hover:text-neutral-300">
                  {r.title}
                </h3>
                <p className="mt-1 text-sm text-neutral-500">{r.excerpt}</p>
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

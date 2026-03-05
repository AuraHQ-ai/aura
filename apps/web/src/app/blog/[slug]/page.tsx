import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getAllBlogPosts,
  getBlogPostBySlug,
  getRelatedPosts,
} from "@/lib/blog";
import { renderMdx } from "@/lib/mdx";

type BlogPostPageProps = {
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
  const posts = await getAllBlogPosts();
  return posts.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: BlogPostPageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = await getBlogPostBySlug(slug);
  if (!post) return {};

  return {
    title: `${post.title} | Aura Blog`,
    description: post.excerpt,
    openGraph: {
      title: post.title,
      description: post.excerpt,
      type: "article",
      url: `https://aurahq.ai/blog/${post.slug}`,
      images: post.ogImage ? [{ url: post.ogImage }] : undefined,
      publishedTime: post.date,
      authors: [post.author],
      tags: post.tags,
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.excerpt,
      images: post.ogImage ? [post.ogImage] : undefined,
    },
  };
}

export default async function BlogPostPage({ params }: BlogPostPageProps) {
  const { slug } = await params;
  const post = await getBlogPostBySlug(slug);
  if (!post) notFound();

  const [content, relatedPosts] = await Promise.all([
    renderMdx(post.content),
    getRelatedPosts(post.slug),
  ]);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-14">
      <Link href="/blog" className="text-sm text-neutral-400 transition hover:text-white">
        ← Back to all posts
      </Link>

      <header className="mt-6 border-b border-white/10 pb-8">
        <h1 className="text-4xl font-semibold tracking-tight text-white">{post.title}</h1>
        <p className="mt-4 text-lg text-neutral-300">{post.excerpt}</p>
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-neutral-500">
          <span>{formatDate(post.date)}</span>
          <span>{post.readingMinutes} min read</span>
          <span>by {post.author}</span>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {post.tags.map((tag) => (
            <Link
              key={tag}
              href={`/blog?tag=${encodeURIComponent(tag)}`}
              className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400 transition hover:border-neutral-500 hover:text-white"
            >
              #{tag}
            </Link>
          ))}
        </div>
      </header>

      <article className="prose prose-invert mt-10 max-w-none">{content}</article>

      {relatedPosts.length > 0 ? (
        <section className="mt-14 border-t border-white/10 pt-8">
          <h2 className="text-xl font-semibold text-white">Related posts</h2>
          <div className="mt-4 space-y-3">
            {relatedPosts.map((related) => (
              <Link
                key={related.slug}
                href={`/blog/${related.slug}`}
                className="block rounded-xl border border-white/10 p-4 transition hover:border-white/30"
              >
                <p className="font-medium text-white">{related.title}</p>
                <p className="mt-1 text-sm text-neutral-400">{related.excerpt}</p>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

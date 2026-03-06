import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  formatDate,
  getAllSlugs,
  getPostBySlug,
  getRelatedPosts,
} from "@/lib/blog";
import { renderMdx } from "@/lib/mdx";

type Props = {
  params: Promise<{ slug: string }>;
};

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
  if (!post) return notFound();

  const [content, related] = await Promise.all([
    renderMdx(post.content),
    getRelatedPosts(post.slug, post.tags),
  ]);

  return (
    <div className="site-inner">
      <article style={{ padding: "64px 0 80px" }}>
        {/* Breadcrumb */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "40px" }}>
          <Link href="/blog" style={{ fontSize: "13px", color: "#999" }}>Blog</Link>
          <span style={{ color: "#ddd" }}>/</span>
        </div>

        {/* Header */}
        <header style={{ marginBottom: "48px" }}>
          <h1
            style={{
              fontSize: "clamp(1.75rem, 4vw, 2.5rem)",
              fontWeight: 700,
              letterSpacing: "-0.03em",
              lineHeight: 1.15,
              color: "#111",
              marginBottom: "20px",
            }}
          >
            {post.title}
          </h1>
          <p style={{ fontSize: "1.0625rem", color: "#666", lineHeight: 1.6, marginBottom: "20px" }}>
            {post.excerpt}
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              fontSize: "13px",
              color: "#bbb",
              borderTop: "1px solid #e5e5e5",
              borderBottom: "1px solid #e5e5e5",
              padding: "14px 0",
            }}
          >
            <time>{formatDate(post.date)}</time>
            <span>·</span>
            <span>{post.readingMinutes} min read</span>
            <span>·</span>
            <span style={{ textTransform: "capitalize" }}>{post.author}</span>
          </div>
          {post.tags.length > 0 && (
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "14px" }}>
              {post.tags.map((tag) => (
                <span key={tag} className="tag">{tag}</span>
              ))}
            </div>
          )}
        </header>

        {/* Content */}
        <div className="prose">{content}</div>
      </article>

      {/* Related */}
      {related.length > 0 && (
        <aside
          style={{
            borderTop: "1px solid #e5e5e5",
            padding: "48px 0",
          }}
        >
          <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#111", marginBottom: "24px" }}>
            Related posts
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
            {related.map((r) => (
              <Link
                key={r.slug}
                href={`/blog/${r.slug}`}
                style={{
                  display: "block",
                  padding: "20px 0",
                  borderBottom: "1px solid #e5e5e5",
                  textDecoration: "none",
                }}
              >
                <h3 style={{ fontSize: "0.9375rem", fontWeight: 600, color: "#111", marginBottom: "4px" }}>
                  {r.title}
                </h3>
                <p style={{ fontSize: "0.875rem", color: "#888", lineHeight: 1.6, margin: 0 }}>
                  {r.excerpt}
                </p>
              </Link>
            ))}
          </div>
        </aside>
      )}

      <div style={{ padding: "32px 0 64px" }}>
        <Link href="/blog" style={{ fontSize: "13px", color: "#888" }}>
          ← All posts
        </Link>
      </div>
    </div>
  );
}

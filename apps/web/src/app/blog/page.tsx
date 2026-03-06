import Link from "next/link";
import { getAllPosts } from "@/lib/blog";

export const metadata = {
  title: "Blog — Aura",
  description: "Notes from an AI that builds itself.",
};

export default async function BlogPage() {
  const posts = await getAllPosts();

  return (
    <div className="site-inner">
      {/* Header */}
      <div style={{ padding: "64px 0 48px", borderBottom: "1px solid #e5e5e5" }}>
        <p style={{ fontSize: "12px", fontWeight: 600, letterSpacing: "0.08em", color: "#999", textTransform: "uppercase", marginBottom: "12px" }}>
          Blog
        </p>
        <h1 style={{ fontSize: "2rem", fontWeight: 700, letterSpacing: "-0.03em", color: "#111", margin: 0 }}>
          Notes from the inside
        </h1>
      </div>

      {/* Post list */}
      <div>
        {posts.map((post, i) => (
          <Link
            key={post.slug}
            href={`/blog/${post.slug}`}
            style={{ display: "block", textDecoration: "none" }}
          >
            <article
              style={{
                padding: "36px 0",
                borderBottom: "1px solid #e5e5e5",
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: "24px",
                alignItems: "start",
                cursor: "pointer",
              }}
            >
              <div>
                <h2
                  style={{
                    fontSize: "1.0625rem",
                    fontWeight: 600,
                    color: "#111",
                    letterSpacing: "-0.01em",
                    marginBottom: "8px",
                    lineHeight: 1.35,
                  }}
                >
                  {post.title}
                </h2>
                <p style={{ fontSize: "0.9375rem", color: "#666", lineHeight: 1.6, margin: "0 0 12px" }}>
                  {post.excerpt}
                </p>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  {post.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="tag">{tag}</span>
                  ))}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <time style={{ fontSize: "13px", color: "#bbb", whiteSpace: "nowrap" }}>
                  {new Date(post.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </time>
                <div style={{ fontSize: "12px", color: "#ccc", marginTop: "4px" }}>{post.readingMinutes} min read</div>
              </div>
            </article>
          </Link>
        ))}
      </div>
    </div>
  );
}

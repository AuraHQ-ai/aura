import { Metadata } from "next";
import Link from "next/link";
import { getAllPosts, getAllTags } from "@/lib/blog";

export const metadata: Metadata = {
  title: "Blog — Aura",
  description:
    "Engineering stories from an AI that builds its own brain. Memory systems, retrieval, self-improvement, and the messy reality of shipping AI at work.",
  openGraph: {
    title: "Blog — Aura",
    description:
      "Engineering stories from an AI that builds its own brain.",
    url: "https://aurahq.ai/blog",
    siteName: "Aura",
    type: "website",
  },
};

export default async function BlogIndex({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string }>;
}) {
  const params = await searchParams;
  const activeTag = params.tag;
  const allPosts = getAllPosts();
  const allTags = getAllTags();
  const posts = activeTag
    ? allPosts.filter((p) => p.tags.includes(activeTag))
    : allPosts;

  return (
    <main className="mx-auto max-w-4xl px-6 py-24">
      <header className="mb-16">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Blog
        </h1>
        <p className="mt-4 text-lg text-neutral-400">
          Engineering stories from an AI that builds its own brain.
        </p>
      </header>

      {allTags.length > 0 && (
        <nav className="mb-12 flex flex-wrap gap-2">
          <Link
            href="/blog"
            className={`rounded-full px-3 py-1 text-sm transition ${
              !activeTag
                ? "bg-white text-black"
                : "bg-neutral-800 text-neutral-400 hover:text-white"
            }`}
          >
            All
          </Link>
          {allTags.map((tag) => (
            <Link
              key={tag}
              href={`/blog?tag=${tag}`}
              className={`rounded-full px-3 py-1 text-sm transition ${
                activeTag === tag
                  ? "bg-white text-black"
                  : "bg-neutral-800 text-neutral-400 hover:text-white"
              }`}
            >
              {tag}
            </Link>
          ))}
        </nav>
      )}

      {posts.length === 0 ? (
        <p className="text-neutral-500">No posts yet. Check back soon.</p>
      ) : (
        <div className="space-y-12">
          {posts.map((post) => (
            <article key={post.slug} className="group">
              <Link href={`/blog/${post.slug}`} className="block">
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-3 text-sm text-neutral-500">
                    <time dateTime={post.date}>
                      {new Date(post.date).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })}
                    </time>
                    <span className="text-neutral-700">·</span>
                    <span>{post.readingTime}</span>
                  </div>
                  <h2 className="text-2xl font-semibold tracking-tight transition group-hover:text-neutral-300">
                    {post.title}
                  </h2>
                  <p className="text-neutral-400 leading-relaxed">
                    {post.excerpt}
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {post.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-500"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              </Link>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}

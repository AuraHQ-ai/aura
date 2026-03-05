import Link from "next/link";
import { getAllBlogPosts, getAllBlogTags } from "@/lib/blog";

type BlogPageProps = {
  searchParams?: Promise<{ tag?: string }>;
};

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function BlogPage({ searchParams }: BlogPageProps) {
  const params = searchParams ? await searchParams : {};
  const selectedTag = typeof params.tag === "string" ? params.tag : "";

  const [posts, tags] = await Promise.all([getAllBlogPosts(), getAllBlogTags()]);
  const visiblePosts = selectedTag
    ? posts.filter((post) => post.tags.includes(selectedTag))
    : posts;

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-14">
      <div className="mb-10 flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-neutral-500">Blog</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white">
            Build notes from Aura&apos;s brain
          </h1>
        </div>
        <Link
          href="/blog/feed.xml"
          className="text-sm font-medium text-neutral-300 underline-offset-4 transition hover:text-white hover:underline"
        >
          RSS feed
        </Link>
      </div>

      <div className="mb-10 flex flex-wrap gap-2">
        <Link
          href="/blog"
          className={`rounded-full border px-3 py-1 text-xs transition ${
            selectedTag
              ? "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-white"
              : "border-white/30 text-white"
          }`}
        >
          All
        </Link>
        {tags.map((tag) => (
          <Link
            key={tag}
            href={`/blog?tag=${encodeURIComponent(tag)}`}
            className={`rounded-full border px-3 py-1 text-xs transition ${
              selectedTag === tag
                ? "border-white/30 text-white"
                : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-white"
            }`}
          >
            #{tag}
          </Link>
        ))}
      </div>

      <div className="space-y-6">
        {visiblePosts.map((post) => (
          <article
            key={post.slug}
            className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition hover:border-white/30"
          >
            <Link href={`/blog/${post.slug}`} className="group">
              <h2 className="text-2xl font-semibold text-white group-hover:underline">
                {post.title}
              </h2>
            </Link>
            <p className="mt-3 text-neutral-300">{post.excerpt}</p>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-500">
              <span>{formatDate(post.date)}</span>
              <span>{post.readingMinutes} min read</span>
              <span>by {post.author}</span>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {post.tags.map((tag) => (
                <Link
                  key={`${post.slug}-${tag}`}
                  href={`/blog?tag=${encodeURIComponent(tag)}`}
                  className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400 transition hover:border-neutral-500 hover:text-white"
                >
                  #{tag}
                </Link>
              ))}
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}

import { Feed } from "feed";
import { getAllPosts } from "@/lib/blog";

const SITE_URL = "https://aurahq.ai";

export async function GET() {
  const posts = await getAllPosts();

  const feed = new Feed({
    title: "Aura Blog",
    description:
      "Engineering stories from an AI that builds its own brain.",
    id: SITE_URL,
    link: `${SITE_URL}/blog`,
    language: "en",
    favicon: `${SITE_URL}/favicon.ico`,
    copyright: `${new Date().getFullYear()} Aura / RealAdvisor`,
    author: {
      name: "Aura",
      link: SITE_URL,
    },
  });

  for (const post of posts) {
    feed.addItem({
      title: post.title,
      id: `${SITE_URL}/blog/${post.slug}`,
      link: `${SITE_URL}/blog/${post.slug}`,
      description: post.excerpt,
      author: [{ name: post.author }],
      date: new Date(post.date),
      category: post.tags.map((t) => ({ name: t })),
    });
  }

  return new Response(feed.rss2(), {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "s-maxage=1800, stale-while-revalidate=3600",
    },
  });
}

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/blog/*": ["../../content/blog/**/*.mdx"],
  },
};

export default nextConfig;

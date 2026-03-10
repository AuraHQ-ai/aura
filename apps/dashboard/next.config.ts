import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@aura/db"],
  serverExternalPackages: ["@neondatabase/serverless"],
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

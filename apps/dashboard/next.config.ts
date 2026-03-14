import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@aura/db"],
  serverExternalPackages: ["@neondatabase/serverless"],
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@neondatabase/serverless"],
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

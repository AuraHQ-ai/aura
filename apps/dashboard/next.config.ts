import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
  outputFileTracingIncludes: {
    "/*": ["../../src/db/**/*"],
  },
  serverExternalPackages: ["@neondatabase/serverless"],
};

export default nextConfig;

import path from "node:path";

import type { NextConfig } from "next";

const isFastBuild = process.env.NEXT_FAST_BUILD === "1";
const tsconfigPath = process.env.NEXT_BUILD_TSCONFIG_PATH || "./tsconfig.json";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: isFastBuild,
    tsconfigPath,
  },
  outputFileTracingRoot: path.join(__dirname, ".."),
  serverExternalPackages: ["@sparticuz/chromium", "playwright-core"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.r2.cloudflarestorage.com",
      },
      {
        protocol: "https",
        hostname: "*.r2.dev",
      },
    ],
  },
};

export default nextConfig;

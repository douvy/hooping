import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // silence the multi-lockfile workspace-root inference warning
  turbopack: { root: process.cwd() },
};

export default nextConfig;

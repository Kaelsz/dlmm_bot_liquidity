import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module: it must be required at runtime rather
  // than bundled by the server compiler.
  serverExternalPackages: ["better-sqlite3"],
  // Self-hosted on a VPS: emit a minimal standalone server for the Docker image.
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;

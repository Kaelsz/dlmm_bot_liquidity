import type { NextConfig } from "next";

/**
 * better-sqlite3 is a native addon. Its loader (`bindings`) resolves the
 * compiled .node file at runtime using require('fs') and require('path'),
 * which the bundler cannot follow — it reports "Module not found: Can't
 * resolve 'path'".
 *
 * `serverExternalPackages` covers route handlers and server components but
 * NOT the instrumentation bundle, and a failure there is fatal in a way that
 * is easy to misdiagnose: the collector still runs (the runtime require
 * succeeds), yet every route returns 500 with the stale compile error. So we
 * also declare them as webpack externals for the server build.
 */
const NATIVE_DEPS = ["better-sqlite3", "bindings", "file-uri-to-path"];

const nextConfig: NextConfig = {
  // @meteora-ag/dlmm publie un build ESM qui fait des imports de
  // répertoire, refusés par le résolveur de Node. Le laisser hors du bundle
  // force la résolution CJS, qui fonctionne.
  serverExternalPackages: [...NATIVE_DEPS, "pino", "@meteora-ag/dlmm", "@solana/web3.js"],
  // Self-hosted on a VPS: emit a minimal standalone server for the Docker image.
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,

  webpack: (config, { isServer }) => {
    if (!isServer) return config;
    const existing = Array.isArray(config.externals)
      ? config.externals
      : config.externals
        ? [config.externals]
        : [];
    config.externals = [
      ...existing,
      // A function rather than a bare list: it also has to catch `node:`-prefixed
      // builtins, which the instrumentation bundle otherwise rejects outright
      // with "Reading from node:fs is not handled by plugins".
      ({ request }: { request?: string }, cb: (err?: null, result?: string) => void) => {
        if (!request) return cb();
        if (request.startsWith("node:")) return cb(null, `commonjs ${request}`);
        if (NATIVE_DEPS.includes(request)) return cb(null, `commonjs ${request}`);
        return cb();
      },
    ];
    return config;
  },
};

export default nextConfig;

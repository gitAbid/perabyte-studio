import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Next 16 defaults this to true: every route's modules are loaded into
    // memory at server start. Loading lazily keeps the dev footprint small.
    preloadEntriesOnStart: false,
    // Webpack-only knob (active under `next dev --webpack`); Turbopack ignores
    // it and has no memory-limit option in Next 16 — it self-manages memory.
    webpackMemoryOptimizations: true,
  },
  // History was absorbed by the studio libraries: old links land on Images.
  async redirects() {
    return [{ source: "/history", destination: "/images", permanent: true }];
  },
  // Next 16 blocks dev resources (HMR, dev client bootstrap) for origins it
  // doesn't allowlist — browsing http://127.0.0.1:3100 while the server
  // advertises localhost silently kills hydration. Allow both spellings.
  allowedDevOrigins: ["127.0.0.1"],
  // The Sogni SDK owns a WebSocket client; keep it out of the server bundle.
  serverExternalPackages: ["@sogni-ai/sogni-client"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "image.pollinations.ai" },
      { protocol: "https", hostname: "pollinations.ai" },
    ],
  },
};

export default nextConfig;
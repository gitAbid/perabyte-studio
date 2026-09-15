import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
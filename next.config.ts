import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
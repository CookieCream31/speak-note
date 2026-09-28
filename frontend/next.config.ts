import type { NextConfig } from "next";

const backendInternalUrl = process.env.BACKEND_INTERNAL_URL ?? "http://backend:8001";
const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "localhost")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  output: "standalone",
  // The browser reaches this Ubuntu host over the LAN while Next.js runs in Docker.
  // Allow the development HMR channel so it does not fall back to full page reloads.
  allowedDevOrigins,
  experimental: {
    // Keep this aligned with the Backend's largest upload limit.
    // Next.js otherwise rejects large proxied request bodies.
    proxyClientMaxBodySize: "4096mb",
  },
  async headers() {
    if (process.env.NODE_ENV !== "development") return [];
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, max-age=0" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${backendInternalUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;

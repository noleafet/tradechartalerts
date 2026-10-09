import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone", 
  skipTrailingSlashRedirect: true,
  async rewrites() {
    const backendUrl = (process.env.BACKEND_URL ?? "http://localhost:8000").replace(/\/+$/, "");
    const apiTarget = `${backendUrl}/api`;
    return [
      {
        source: "/api/proxy/:path*",
        destination: `${apiTarget}/:path*/`,
      },
      {
        source: "/api/:path*",
        destination: `${apiTarget}/:path*/`,
      },
    ];
  },
};

export default nextConfig;

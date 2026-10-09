import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone", 
  async rewrites() {
    const apiTarget = (process.env.API_PROXY_TARGET ?? "https://tca-admin.noleafet.blitz.cloud/api").replace(/\/$/, "");
    return [
      {
        source: "/api/blitz/:path*",
        destination: `${apiTarget}/:path*`,
      },
    ];
  },
};

export default nextConfig;

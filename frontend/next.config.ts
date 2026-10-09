import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone", 
  
  async rewrites() {
    return [
      {
        // 1. Catches frontend requests directed at /api/blitz/
        source: '/api/blitz/:path*',
        // 2. Maps the variable path correctly to your live tca-admin subdomain
        destination: 'https://blitz.cloud*',
      },
    ]
  },
};

export default nextConfig;

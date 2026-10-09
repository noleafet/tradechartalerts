import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone", // Keep your standalone output for Docker/Vercel
  
  async rewrites() {
    return [
      {
        // This intercepts any frontend fetch request to /api/blitz/...
        source: '/api/blitz/:path*',
        // This forwards it securely behind the scenes to your backend server
        destination: 'https://tca-admin.noleafet.blitz.cloud*',
      },
    ]
  },
};

export default nextConfig;



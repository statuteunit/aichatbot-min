import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  devIndicators: false,
};
if (process.env.NODE_ENV === 'development') {
  nextConfig.rewrites = async () => {
    return [
      {
        source: '/chat/:path*',
        // 代理请求next自身api/chat
        destination: `${process.env.OPENROUTER_BASE_URL}/chat/:path*`
      }
    ]
  }
}

export default nextConfig;

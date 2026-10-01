import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Gera .next/standalone com um server.js mínimo para a imagem Docker.
  output: "standalone",
  poweredByHeader: false,
  // Em `npm run dev` fora do Docker, encaminha /api para o back local.
  async rewrites() {
    const backend = process.env.BACKEND_URL;
    return backend ? [{ source: "/api/:path*", destination: `${backend}/api/:path*` }] : [];
  },
};

export default nextConfig;

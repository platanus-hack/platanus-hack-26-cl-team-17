import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Imagen mínima para Cloud Run: `next build` genera .next/standalone con su propio server.js.
  output: "standalone",
  // pg y el SDK de Cloud Storage se cargan desde node_modules en tiempo de ejecución (no se empaquetan).
  serverExternalPackages: ["pg", "@google-cloud/storage"],
  // La plataforma es casi enteramente dinámica (datos en vivo vía /api + sondeo),
  // así que no se usa Cache Components ni prerender parcial.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

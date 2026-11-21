import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Imagen mínima para Cloud Run: `next build` genera .next/standalone con su propio server.js.
  output: "standalone",
  // pg y el SDK de Cloud Storage se cargan desde node_modules en tiempo de ejecución (no se empaquetan).
  serverExternalPackages: ["pg", "@google-cloud/storage"],
  // Solo desarrollo: abrir `next dev` desde otro equipo de la red del evento (por la IP del notebook).
  allowedDevOrigins: ["10.105.132.7", "10.105.132.*", "172.16.1.45", "172.16.1.*"],
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

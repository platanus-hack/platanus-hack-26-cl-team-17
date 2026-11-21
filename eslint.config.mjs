import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Entornos de Python (gpu/splat, detector): traen miles de .js de terceros y
    // recorrerlos agota la memoria de la máquina.
    "**/.venv/**",
    // Servicio del detector (Python); sus modelos incluyen un binario con extensión .ts.
    "detector/**",
  ]),
]);

export default eslintConfig;

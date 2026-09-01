import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const uiRoot = fileURLToPath(new URL("./ui", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: string };
const buildVersion = process.env.BUILD_VERSION?.trim() || manifest.version || "dev";
const buildTime = process.env.BUILD_TIME?.trim() || new Date().toISOString();

export default defineConfig({
  root: uiRoot,
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_VERSION__: JSON.stringify(buildVersion),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4320",
    },
  },
});

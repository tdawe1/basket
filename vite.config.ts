import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  root: "src/client",
  publicDir: resolve(import.meta.dirname, "src/client/public"),
  build: {
    outDir: resolve(import.meta.dirname, "dist/client"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:3000", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:3000", ws: true },
    },
  },
});

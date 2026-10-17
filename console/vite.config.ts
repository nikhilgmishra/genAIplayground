import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Operations console build. The dev server proxies the console API to the local
 * platform (`pnpm start`, default 127.0.0.1:8080). No other origin is contacted.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/console/api": { target: "http://127.0.0.1:8080", changeOrigin: false, secure: true },
    },
  },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});

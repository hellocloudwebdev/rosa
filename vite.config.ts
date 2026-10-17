import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@shared": path.resolve(import.meta.dirname, "./shared"),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: false,
    // The API runs as a separate Node process; proxy keeps one origin for the
    // browser so cookies stay first-party and no CORS is needed in dev.
    proxy: {
      "/api": {
        target: process.env.ROSA_API_ORIGIN ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
    watch: {
      ignored: ["**/src-tauri/**", "**/.mimosa/**", "**/.zcode/**", "**/data/**"],
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
}));

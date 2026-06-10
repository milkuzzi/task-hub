import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import compression from "vite-plugin-compression";

// Pre-compress static assets at build (brotli + gzip) so Nginx serves
// .br/.gz directly. Route-level code splitting via React.lazy keeps each
// route chunk ≤ 60 KB gzip and initial JS ≤ 180 KB gzip (budget enforced in CI).
export default defineConfig({
  plugins: [
    react(),
    compression({ algorithm: "brotliCompress", ext: ".br" }),
    compression({ algorithm: "gzip", ext: ".gz" }),
  ],
  build: {
    target: "es2020",
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query", "@tanstack/react-virtual"],
        },
      },
    },
  },
  server: { proxy: { "/api": "http://localhost:8000" } },
});

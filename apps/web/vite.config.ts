import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GH Pages serves the site under /homepage/; override with VITE_BASE ("/" for
// <user>.github.io root deploys). In dev, /ws and /api proxy to the local
// shell-server so the frontend can use same-origin URLs.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/homepage/",
  plugins: [react()],
  server: {
    proxy: {
      "/ws": { target: "ws://localhost:8787", ws: true },
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

// HMR iteration (`npm run dev:web`): the dashboard fetches same-origin /api/*,
// so forward API traffic to a locally running daemon. Override when the daemon
// binds somewhere other than the default 8787.
const devApi = process.env.QUOTACAP_DEV_API || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  root: path.dirname(fileURLToPath(import.meta.url)),
  build: { outDir: "dist" },
  server: {
    port: 5173,
    proxy: {
      "/api": devApi,
      "/health": devApi,
    },
  },
});

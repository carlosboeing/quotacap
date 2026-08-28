import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [react()],
  root: path.dirname(fileURLToPath(import.meta.url)),
  build: { outDir: "dist" },
});

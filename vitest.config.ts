import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["tests/bun/**", "node_modules/**", "dist/**"],
  },
});
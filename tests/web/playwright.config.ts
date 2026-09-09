import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "dashboard.spec.ts",
  timeout: 30000,
  workers: 1,
  use: { browserName: "chromium", trace: "off" },
});

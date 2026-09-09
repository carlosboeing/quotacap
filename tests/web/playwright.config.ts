import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // Named .e2e.ts (not .spec.ts) so vitest, which also collects *.spec.ts,
  // never picks up this Playwright-only suite. No shared config change needed.
  testMatch: "dashboard.e2e.ts",
  timeout: 30000,
  workers: 1,
  use: { browserName: "chromium", trace: "off" },
});

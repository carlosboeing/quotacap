import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // Named .e2e.ts (not .spec.ts) so vitest, which also collects *.spec.ts,
  // never picks up this Playwright-only suite. Runs the real daemon plus the
  // real dashboard in a browser; keep independent of tests/web/dashboard.e2e.ts.
  testMatch: "dashboard.e2e.ts",
  timeout: 90000,
  workers: 1,
  use: { browserName: "chromium", channel: "chrome", trace: "off" },
});

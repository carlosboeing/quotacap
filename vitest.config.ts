import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Fixtures carry +10:00 instants and the shared clock prints local wall
    // time, so pin a zone without daylight saving to make clock strings
    // identical on every machine and in CI.
    env: { TZ: "Australia/Brisbane" },
    exclude: ["tests/bun/**", "**/node_modules/**", "dist/**", "dist-bin/**", ".worktrees/**", ".workbench/**", "**/dist/**"],
  },
});
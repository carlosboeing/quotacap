import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { adapters } from "../../src/adapters/index.js";
import { readConfig } from "../../src/config.js";

afterEach(() => {
  delete process.env.QUOTACAP_HOME;
});

describe("adapter registry", () => {
  it("registers claude, manual, codex, kimi, grok and agy", () => {
    expect(Object.keys(adapters).sort()).toEqual(["agy", "claude", "codex", "grok", "kimi", "manual"]);
    for (const id of ["claude", "codex", "kimi", "grok", "agy", "manual"]) {
      expect(adapters[id].id).toBe(id);
    }
  });
});

describe("config defaults", () => {
  it("enables claude, codex, kimi, grok and agy by default", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "qc-cfg-"));
    process.env.QUOTACAP_HOME = home;
    const cfg = await readConfig();
    expect(cfg.enabledProviders).toEqual(["claude", "codex", "kimi", "grok", "agy"]);
  });
});

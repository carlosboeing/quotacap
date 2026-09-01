import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as pty from "../../src/adapters/pty.js";
import { adapters, pollAll } from "../../src/adapters/index.js";
import { codexAdapter, parseCodexTui } from "../../src/adapters/codex.js";
import { kimiAdapter, parseKimiTui } from "../../src/adapters/kimi.js";
import { grokAdapter, parseGrokTui } from "../../src/adapters/grok.js";
import { claudeAdapter, parseClaudeUsage } from "../../src/adapters/claude.js";
import { agyAdapter, parseAgyUsage } from "../../src/adapters/agy.js";
import { manualAdapter, parseManualUsage } from "../../src/adapters/manual.js";

const SENSITIVE_PATTERNS = [
  /auth\.json/i,
  /\.codex/i,
  /\.kimi/i,
  /kimi-code/i,
  /\.grok/i,
  /\.qc-bak/i,
  /\.qc-lock/i,
  /\.qc-tmp/i,
];

describe("Credential-free adapters regression", () => {
  describe("Static code verification", () => {
    it("src/ contains no references to refresh_token, auth.json, qc-bak, or persistCreds", async () => {
      const srcDir = path.resolve(__dirname, "../../src");
      const files: string[] = [];

      async function scan(dir: string) {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            await scan(full);
          } else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".js"))) {
            files.push(full);
          }
        }
      }

      await scan(srcDir);
      expect(files.length).toBeGreaterThan(0);

      const forbidden = [
        "refresh_token",
        "grant_type",
        "auth.json",
        "qc-bak",
        "qc-lock",
        "persistCreds",
        "app_EMoamEEZ73f0CkXaXp7hrann",
        "17e5f671-d194-4dfb-9706-5516cb48c098",
      ];

      for (const file of files) {
        const content = await fsp.readFile(file, "utf8");
        for (const pattern of forbidden) {
          expect(
            content.includes(pattern),
            `File ${path.relative(srcDir, file)} contains forbidden token "${pattern}"`,
          ).toBe(false);
        }
      }
    });

    it("adapters export requiresAuth indicating CLI ownership or none", () => {
      for (const [name, adapter] of Object.entries(adapters)) {
        expect(adapter.requiresAuth).toBeDefined();
        expect(adapter.requiresAuth).not.toMatch(/auth\.json|\.qc-bak|refresh_token/i);
      }
    });
  });

  describe("Runtime fs-level spy verification", () => {
    it("parsers do not touch any credential files or fs paths", () => {
      const accessedPaths: string[] = [];
      const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((file: any, ...args: any[]) => {
        if (typeof file === "string") accessedPaths.push(file);
        return (fs.readFileSync as any).wrappedMethod ? (fs.readFileSync as any).wrappedMethod(file, ...args) : "";
      });

      try {
        const now = new Date("2026-09-01T00:00:00Z");

        parseCodexTui("5h limit: 10% left (resets 14:00)\nWeekly limit: 50% left (resets 16:00 on 7 Sep)\n", now);
        parseKimiTui("Weekly limit  10% used  resets in 2d\n5h limit  20% used  resets in 1h\n", now);
        parseGrokTui("Weekly limit (SuperGrok)  30%\nCredits: $5.00\nResets: September 7, 10:22\n", now);
        parseClaudeUsage("Current session: 10% used · resets Aug 28 at 4:30pm (Australia/Brisbane)\nCurrent week (all models): 20% used · resets Sep 3 at 9pm (Australia/Brisbane)\n", now);
        parseAgyUsage({
          status: "SUCCESS",
          command: {
            data: {
              groups: [
                {
                  name: "Gemini Models",
                  buckets: [{ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.8, reset_time: "2026-09-01T12:00:00Z" }],
                },
              ],
            },
          },
        }, now);
        parseManualUsage("custom", "50% used · resets Aug 29 at 11am", now);

        for (const p of accessedPaths) {
          for (const pattern of SENSITIVE_PATTERNS) {
            expect(pattern.test(p), `Parser unexpectedly accessed sensitive file: ${p}`).toBe(false);
          }
        }
      } finally {
        readSpy.mockRestore();
      }
    });

    it("credential files in homedir remain completely untouched during adapter poll() execution", async () => {
      const mockHome = await fsp.mkdtemp(path.join(os.tmpdir(), "qc-mockhome-"));

      // Setup dummy credential files as if CLIs had logged in
      const codexAuth = path.join(mockHome, ".codex", "auth.json");
      const kimiCreds = path.join(mockHome, ".kimi-code", "credentials", "kimi-code.json");
      const grokAuth = path.join(mockHome, ".grok", "auth.json");

      await fsp.mkdir(path.dirname(codexAuth), { recursive: true });
      await fsp.writeFile(codexAuth, JSON.stringify({ access_token: "dummy_codex_tok", refresh_token: "dummy_codex_rf" }));

      await fsp.mkdir(path.dirname(kimiCreds), { recursive: true });
      await fsp.writeFile(kimiCreds, JSON.stringify({ access_token: "dummy_kimi_tok", refresh_token: "dummy_kimi_rf" }));

      await fsp.mkdir(path.dirname(grokAuth), { recursive: true });
      await fsp.writeFile(grokAuth, JSON.stringify({ access_token: "dummy_grok_tok", refresh_token: "dummy_grok_rf" }));

      // Mock PTY runner to return simulated TUI output and verify cwd matches os.homedir()
      const runPtySpy = vi.spyOn(pty, "runPty").mockImplementation(async (opts) => {
        expect(opts.cwd).toBe(mockHome);
        if (opts.file === "codex") {
          return "5h limit: 9% left (resets 14:12)\nWeekly limit: 73% left (resets 16:36 on 7 Sep)\n";
        }
        if (opts.file === "kimi") {
          return "Welcome to Kimi Code\nWeekly limit  7% used   resets in 6d 19h 57m\n5h limit      33% used  resets in 57m\n";
        }
        if (opts.file === "grok") {
          return "Weekly limit (SuperGrok)  26%\nCredits: $4.85\nResets: September 7, 10:22\n";
        }
        throw new Error(`Unexpected pty file: ${opts.file}`);
      });

      // Setup mock executable script for claudeAdapter
      const mockClaudeScript = path.join(mockHome, "mock-claude.sh");
      const claudeSample =
        "Current session: 46% used · resets Aug 28 at 4:30pm (Australia/Brisbane)\nCurrent week (all models): 25% used · resets Sep 3 at 9pm (Australia/Brisbane)\n";
      const claudeJson = JSON.stringify({ result: claudeSample });
      await fsp.writeFile(mockClaudeScript, `#!/bin/sh\nprintf '%s' '${claudeJson}'\n`, { mode: 0o755 });

      const origHome = process.env.HOME;
      const origExecPath = claudeAdapter.execPath;
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(mockHome);
      process.env.HOME = mockHome;
      claudeAdapter.execPath = mockClaudeScript;

      const accessedPaths: string[] = [];
      const readSpy = vi.spyOn(fsp, "readFile").mockImplementation(async (file: any, ...args: any[]) => {
        if (typeof file === "string") accessedPaths.push(file);
        return (fsp.readFile as any).wrappedMethod ? (fsp.readFile as any).wrappedMethod(file, ...args) : "";
      });

      try {
        const codexStatBefore = await fsp.stat(codexAuth);
        const kimiStatBefore = await fsp.stat(kimiCreds);
        const grokStatBefore = await fsp.stat(grokAuth);

        // 1. Exercise codexAdapter.poll()
        const codexQuota = await codexAdapter.poll();
        expect(codexQuota.provider).toBe("codex");
        expect(codexQuota.usedPct).toBe(27);
        expect(codexQuota.source).toBe("tui");

        // 2. Exercise kimiAdapter.poll()
        const kimiQuota = await kimiAdapter.poll();
        expect(kimiQuota.provider).toBe("kimi");
        expect(kimiQuota.usedPct).toBe(7);
        expect(kimiQuota.source).toBe("tui");

        // 3. Exercise grokAdapter.poll()
        const grokQuota = await grokAdapter.poll();
        expect(grokQuota.provider).toBe("grok");
        expect(grokQuota.usedPct).toBe(26);
        expect(grokQuota.creditsUsd).toBe(4.85);
        expect(grokQuota.source).toBe("tui");

        // 4. Exercise claudeAdapter.poll()
        const claudeQuota = await claudeAdapter.poll();
        expect(claudeQuota.provider).toBe("claude");
        expect(claudeQuota.usedPct).toBe(25);
        expect(claudeQuota.source).toBe("cli");

        // 5. Exercise pollAll across all providers
        const results = await pollAll(["claude", "codex", "kimi", "grok", "manual"]);
        expect(results).toHaveLength(5);
        expect(results.find((r) => r.provider === "codex")?.status).toBe("fulfilled");
        expect(results.find((r) => r.provider === "kimi")?.status).toBe("fulfilled");
        expect(results.find((r) => r.provider === "grok")?.status).toBe("fulfilled");
        expect(results.find((r) => r.provider === "claude")?.status).toBe("fulfilled");
        expect(results.find((r) => r.provider === "manual")?.status).toBe("skipped");

        // Verify none of the accessed paths were sensitive credential files
        for (const p of accessedPaths) {
          for (const pattern of SENSITIVE_PATTERNS) {
            expect(pattern.test(p), `poll() unexpectedly accessed sensitive path: ${p}`).toBe(false);
          }
        }

        // Verify credential files in mockHome were completely untouched
        const codexStatAfter = await fsp.stat(codexAuth);
        const kimiStatAfter = await fsp.stat(kimiCreds);
        const grokStatAfter = await fsp.stat(grokAuth);

        expect(codexStatAfter.mtimeMs).toBe(codexStatBefore.mtimeMs);
        expect(kimiStatAfter.mtimeMs).toBe(kimiStatBefore.mtimeMs);
        expect(grokStatAfter.mtimeMs).toBe(grokStatBefore.mtimeMs);

        // Verify no backup or lock files were created
        const codexDir = await fsp.readdir(path.join(mockHome, ".codex"));
        expect(codexDir).toEqual(["auth.json"]);

        const kimiDir = await fsp.readdir(path.join(mockHome, ".kimi-code", "credentials"));
        expect(kimiDir).toEqual(["kimi-code.json"]);

        const grokDir = await fsp.readdir(path.join(mockHome, ".grok"));
        expect(grokDir).toEqual(["auth.json"]);
      } finally {
        readSpy.mockRestore();
        homedirSpy.mockRestore();
        runPtySpy.mockRestore();
        process.env.HOME = origHome;
        claudeAdapter.execPath = origExecPath;
        await fsp.rm(mockHome, { recursive: true, force: true });
      }
    });
  });
});

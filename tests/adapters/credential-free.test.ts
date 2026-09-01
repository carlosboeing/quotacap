import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adapters } from "../../src/adapters/index.js";
import { parseCodexTui } from "../../src/adapters/codex.js";
import { parseKimiTui } from "../../src/adapters/kimi.js";
import { parseGrokTui } from "../../src/adapters/grok.js";
import { parseClaudeUsage } from "../../src/adapters/claude.js";
import { parseAgyUsage } from "../../src/adapters/agy.js";
import { parseManualUsage } from "../../src/adapters/manual.js";

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
        // None of the adapters should require oauth tokens or file paths
        expect(adapter.requiresAuth).not.toMatch(/auth\.json|\.qc-bak|refresh_token/i);
      }
    });
  });

  describe("Runtime fs-level spy verification", () => {
    let accessedPaths: string[] = [];
    let originalReadFile: typeof fsp.readFile;
    let originalReadFileSync: typeof fs.readFileSync;
    let originalOpen: typeof fsp.open;
    let originalOpenSync: typeof fs.openSync;
    let originalWriteFile: typeof fsp.writeFile;
    let originalWriteFileSync: typeof fs.writeFileSync;

    beforeEach(() => {
      accessedPaths = [];
      originalReadFile = fsp.readFile;
      originalReadFileSync = fs.readFileSync;
      originalOpen = fsp.open;
      originalOpenSync = fs.openSync;
      originalWriteFile = fsp.writeFile;
      originalWriteFileSync = fs.writeFileSync;

      const record = (target: any) => {
        if (typeof target === "string") {
          accessedPaths.push(target);
        }
      };

      vi.spyOn(fsp, "readFile").mockImplementation(async (file: any, ...args: any[]) => {
        record(file);
        return (originalReadFile as any)(file, ...args);
      });

      vi.spyOn(fs, "readFileSync").mockImplementation((file: any, ...args: any[]) => {
        record(file);
        return (originalReadFileSync as any)(file, ...args);
      });

      vi.spyOn(fsp, "open").mockImplementation(async (file: any, ...args: any[]) => {
        record(file);
        return (originalOpen as any)(file, ...args);
      });

      vi.spyOn(fs, "openSync").mockImplementation((file: any, ...args: any[]) => {
        record(file);
        return (originalOpenSync as any)(file, ...args);
      });

      vi.spyOn(fsp, "writeFile").mockImplementation(async (file: any, ...args: any[]) => {
        record(file);
        return (originalWriteFile as any)(file, ...args);
      });

      vi.spyOn(fs, "writeFileSync").mockImplementation((file: any, ...args: any[]) => {
        record(file);
        return (originalWriteFileSync as any)(file, ...args);
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("parsers do not touch any credential files or fs paths", () => {
      const now = new Date("2026-09-01T00:00:00Z");

      parseCodexTui("5h limit: 10% left (resets 14:00)\nWeekly limit: 50% left (resets 16:00 on 7 Sep)\n", now);
      parseKimiTui("Weekly limit  10% used  resets in 2d\n5h limit  20% used  resets in 1h\n", now);
      parseGrokTui("Weekly limit (SuperGrok)  30%\nCredits: $5.00\nResets: September 7, 10:22\n", now);
      parseClaudeUsage("Current session: 10% used · resets Aug 28 at 4:30pm\nCurrent week: 20% used · resets Sep 3 at 9pm\n", now);
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
    });

    it("credential files in homedir remain completely untouched during polling and parsing", async () => {
      const mockHome = await fsp.mkdtemp(path.join(os.tmpdir(), "qc-mockhome-"));

      // Setup dummy credential files as if CLI had logged in
      const codexAuth = path.join(mockHome, ".codex", "auth.json");
      const kimiCreds = path.join(mockHome, ".kimi-code", "credentials", "kimi-code.json");
      const grokAuth = path.join(mockHome, ".grok", "auth.json");

      await fsp.mkdir(path.dirname(codexAuth), { recursive: true });
      await fsp.writeFile(codexAuth, JSON.stringify({ access_token: "dummy_codex_tok", refresh_token: "dummy_codex_rf" }));

      await fsp.mkdir(path.dirname(kimiCreds), { recursive: true });
      await fsp.writeFile(kimiCreds, JSON.stringify({ access_token: "dummy_kimi_tok", refresh_token: "dummy_kimi_rf" }));

      await fsp.mkdir(path.dirname(grokAuth), { recursive: true });
      await fsp.writeFile(grokAuth, JSON.stringify({ access_token: "dummy_grok_tok", refresh_token: "dummy_grok_rf" }));

      const codexStatBefore = await fsp.stat(codexAuth);
      const kimiStatBefore = await fsp.stat(kimiCreds);
      const grokStatBefore = await fsp.stat(grokAuth);

      // Exercise adapters
      const now = new Date("2026-09-01T00:00:00Z");
      parseCodexTui("5h limit: 10% left (resets 14:00)\nWeekly limit: 50% left (resets 16:00 on 7 Sep)\n", now);
      parseKimiTui("Weekly limit  10% used  resets in 2d\n5h limit  20% used  resets in 1h\n", now);
      parseGrokTui("Weekly limit (SuperGrok)  30%\nCredits: $5.00\nResets: September 7, 10:22\n", now);

      // Verify files were not touched
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

      // Cleanup
      await fsp.rm(mockHome, { recursive: true, force: true });
    });
  });
});

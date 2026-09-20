import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as pty from "../../src/adapters/pty.js";
import * as spawn from "../../src/runtime/spawn.js";
import { catalogFetchers } from "../../src/catalog/index.js";
import { adapters, pollAll } from "../../src/adapters/index.js";
import { codexAdapter, parseCodexTui } from "../../src/adapters/codex.js";
import { kimiAdapter, parseKimiTui } from "../../src/adapters/kimi.js";
import { grokAdapter, parseGrokTui } from "../../src/adapters/grok.js";
import { claudeAdapter, parseClaudeUsage } from "../../src/adapters/claude.js";
import { agyAdapter, parseAgyUsage } from "../../src/adapters/agy.js";
import { museAdapter, parseMuseTui } from "../../src/adapters/muse.js";
import { manualAdapter, parseManualUsage } from "../../src/adapters/manual.js";
import { opencodeGoAdapter, parseOpencodeGoUsage } from "../../src/adapters/opencode-go.js";
import { formatInTimeZone } from "date-fns-tz";

const SENSITIVE_PATTERNS = [
  /auth\.json/i,
  /\.codex/i,
  /\.kimi/i,
  /kimi-code/i,
  /\.grok/i,
  /\.config\/muse/i,
  /\bmuse[-_]?auth/i,
  /share\/muse/i,
  /tui-history/i,
  /\.qc-bak/i,
  /\.qc-lock/i,
  /\.qc-tmp/i,
  /model-catalog/i,
];

const LIVE_BODY = {
  usage: {
    rolling: { status: "ok", percent: 5, resetsAt: "2026-09-17T10:54:52.662Z" },
    weekly: { status: "ok", percent: 8, resetsAt: "2026-09-21T00:00:00.662Z" },
    monthly: { status: "ok", percent: 82, resetsAt: "2026-09-22T13:05:15.662Z" },
  },
};

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

      // The single consented exception: the OpenCode auth file literal lives
      // in exactly two pinned files — the authored adapter that reads it and
      // the generated dashboard bundle that embeds the consent copy naming
      // it. Only that literal in both. Anything else — including OAuth
      // vocabulary inside those files — still fails.
      const staticAllowlist = new Map<string, string[]>([
        [path.join("adapters", "opencode-go.ts"), ["auth.json"]],
        // Generated, committed dashboard bundle (scripts/build-embed.mjs): it
        // embeds the consent copy verbatim, which names the auth file. String
        // data, not credential-reading code; every other forbidden pattern
        // still fails here.
        [path.join("webAssets.ts"), ["auth.json"]],
      ]);

      for (const file of files) {
        const content = await fsp.readFile(file, "utf8");
        const rel = path.relative(srcDir, file);
        const allowed = staticAllowlist.get(rel) ?? [];
        for (const pattern of forbidden) {
          if (allowed.includes(pattern)) continue;
          expect(
            content.includes(pattern),
            `File ${rel} contains forbidden token "${pattern}"`,
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
        parseMuseTui("Subscription · Muse Code High Usage  Current 11% used · Resets at 3:51 PM  Weekly 35% used · Resets Sep 14 at 10:00 AM  as of 12:34 PM", now);
        parseOpencodeGoUsage(LIVE_BODY, now);

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
      const museAuth = path.join(mockHome, ".config", "muse", "auth.json");
      const museHistory = path.join(mockHome, ".config", "muse", "tui-history.jsonl");
      const museSession = path.join(mockHome, ".local", "share", "muse", "sessions", "snap-1.json");
      const opencodeAuth = path.join(mockHome, ".local", "share", "opencode", "auth.json");
      await fsp.mkdir(path.dirname(opencodeAuth), { recursive: true });
      await fsp.writeFile(opencodeAuth, JSON.stringify({ "opencode-go": { type: "api", key: "sk-dummy-go" } }));

      await fsp.mkdir(path.dirname(codexAuth), { recursive: true });
      await fsp.writeFile(codexAuth, JSON.stringify({ access_token: "dummy_codex_tok", refresh_token: "dummy_codex_rf" }));

      await fsp.mkdir(path.dirname(kimiCreds), { recursive: true });
      await fsp.writeFile(kimiCreds, JSON.stringify({ access_token: "dummy_kimi_tok", refresh_token: "dummy_kimi_rf" }));

      await fsp.mkdir(path.dirname(grokAuth), { recursive: true });
      await fsp.writeFile(grokAuth, JSON.stringify({ access_token: "dummy_grok_tok", refresh_token: "dummy_grok_rf" }));

      await fsp.mkdir(path.dirname(museAuth), { recursive: true });
      await fsp.writeFile(museAuth, JSON.stringify({ access_token: "dummy_muse_tok", refresh_token: "dummy_muse_rf" }));
      await fsp.writeFile(museHistory, JSON.stringify({ prompt: "dummy private prompt" }) + "\n");

      await fsp.mkdir(path.dirname(museSession), { recursive: true });
      await fsp.writeFile(museSession, JSON.stringify({ cumulative_tokens: 12345 }));

      // Mock PTY runner to return simulated TUI output and verify cwd matches os.homedir()
      const museReset = formatInTimeZone(new Date(Date.now() + 2 * 86400000), "Australia/Brisbane", "MMM d 'at' h:mm a");
      const runPtySpy = vi.spyOn(pty, "runPty").mockImplementation(async (opts) => {
        if (opts.file === "muse") {
          // Muse probes a QuotaCap-owned dir, never $HOME itself.
          expect(opts.cwd).toBe(path.join(mockHome, ".quotacap", "muse-probe"));
          return `Subscription · Muse Code High Usage  Current 11% used · Resets at 3:51 PM  Weekly 35% used · Resets ${museReset}  as of 12:34 PM`;
        }
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
      const origQcHome = process.env.QUOTACAP_HOME;
      const origExecPath = claudeAdapter.execPath;
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(mockHome);
      process.env.HOME = mockHome;
      delete process.env.QUOTACAP_HOME;
      claudeAdapter.execPath = mockClaudeScript;

      const accessedPaths: string[] = [];
      const readSpy = vi.spyOn(fsp, "readFile").mockImplementation(async (file: any, ...args: any[]) => {
        if (typeof file === "string") accessedPaths.push(file);
        return (fsp.readFile as any).wrappedMethod ? (fsp.readFile as any).wrappedMethod(file, ...args) : "";
      });
      const realReadFileSync = fs.readFileSync;
      const readSyncSpy = vi.spyOn(fs, "readFileSync").mockImplementation((file: any, ...args: any[]) => {
        if (typeof file === "string") accessedPaths.push(file);
        return realReadFileSync(file, ...args);
      });

      try {
        const codexStatBefore = await fsp.stat(codexAuth);
        const kimiStatBefore = await fsp.stat(kimiCreds);
        const grokStatBefore = await fsp.stat(grokAuth);
        const museAuthStatBefore = await fsp.stat(museAuth);
        const museHistoryStatBefore = await fsp.stat(museHistory);
        const museSessionStatBefore = await fsp.stat(museSession);
        const opencodeStatBefore = await fsp.stat(opencodeAuth);

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

        // 4. Exercise museAdapter.poll()
        const museQuota = await museAdapter.poll();
        expect(museQuota.provider).toBe("muse");
        expect(museQuota.plan).toBe("High Usage");
        expect(museQuota.usedPct).toBe(35);
        expect(museQuota.sessionPct).toBe(11);
        expect(museQuota.source).toBe("tui");

        // 5. Exercise claudeAdapter.poll()
        const claudeQuota = await claudeAdapter.poll();
        expect(claudeQuota.provider).toBe("claude");
        expect(claudeQuota.usedPct).toBe(25);
        expect(claudeQuota.source).toBe("cli");

        // 6. Exercise pollAll across all providers
        const results = await pollAll(["claude", "codex", "kimi", "grok", "muse", "manual"]);
        expect(results).toHaveLength(6);
        expect(results.find((r) => r.provider === "codex")?.status).toBe("fulfilled");
        expect(results.find((r) => r.provider === "kimi")?.status).toBe("fulfilled");
        expect(results.find((r) => r.provider === "grok")?.status).toBe("fulfilled");
        expect(results.find((r) => r.provider === "muse")?.status).toBe("fulfilled");
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
        const museAuthStatAfter = await fsp.stat(museAuth);
        const museHistoryStatAfter = await fsp.stat(museHistory);
        const museSessionStatAfter = await fsp.stat(museSession);
        const opencodeStatAfter = await fsp.stat(opencodeAuth);
        expect(opencodeStatAfter.mtimeMs).toBe(opencodeStatBefore.mtimeMs);

        expect(codexStatAfter.mtimeMs).toBe(codexStatBefore.mtimeMs);
        expect(kimiStatAfter.mtimeMs).toBe(kimiStatBefore.mtimeMs);
        expect(grokStatAfter.mtimeMs).toBe(grokStatBefore.mtimeMs);
        expect(museAuthStatAfter.mtimeMs).toBe(museAuthStatBefore.mtimeMs);
        expect(museHistoryStatAfter.mtimeMs).toBe(museHistoryStatBefore.mtimeMs);
        expect(museSessionStatAfter.mtimeMs).toBe(museSessionStatBefore.mtimeMs);

        // Verify no backup or lock files were created
        const codexDir = await fsp.readdir(path.join(mockHome, ".codex"));
        expect(codexDir).toEqual(["auth.json"]);

        const kimiDir = await fsp.readdir(path.join(mockHome, ".kimi-code", "credentials"));
        expect(kimiDir).toEqual(["kimi-code.json"]);

        const grokDir = await fsp.readdir(path.join(mockHome, ".grok"));
        expect(grokDir).toEqual(["auth.json"]);

        const museConfigDir = await fsp.readdir(path.join(mockHome, ".config", "muse"));
        expect(museConfigDir.sort()).toEqual(["auth.json", "tui-history.jsonl"]);

        const museSessionsDir = await fsp.readdir(path.join(mockHome, ".local", "share", "muse", "sessions"));
        expect(museSessionsDir).toEqual(["snap-1.json"]);
      } finally {
        readSpy.mockRestore();
        readSyncSpy.mockRestore();
        homedirSpy.mockRestore();
        runPtySpy.mockRestore();
        process.env.HOME = origHome;
        if (origQcHome === undefined) delete process.env.QUOTACAP_HOME;
        else process.env.QUOTACAP_HOME = origQcHome;
        claudeAdapter.execPath = origExecPath;
        await fsp.rm(mockHome, { recursive: true, force: true });
      }
    });

    it("an enabled opencode-go poll reads only the consented auth path, read-only", async () => {
      const mockHome = await fsp.mkdtemp(path.join(os.tmpdir(), "qc-ocgo-gate-"));
      const opencodeAuth = path.join(mockHome, ".local", "share", "opencode", "auth.json");
      await fsp.mkdir(path.dirname(opencodeAuth), { recursive: true });
      await fsp.writeFile(opencodeAuth, JSON.stringify({ "opencode-go": { type: "api", key: "sk-dummy-go" } }), { mode: 0o600 });

      const origHome = process.env.HOME;
      const origQcHome = process.env.QUOTACAP_HOME;
      const origEnvKey = process.env.OPENCODE_API_KEY;
      delete process.env.OPENCODE_API_KEY;
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(mockHome);
      process.env.HOME = mockHome;
      delete process.env.QUOTACAP_HOME;

      const accessedPaths: string[] = [];
      const realReadFile = fsp.readFile;
      const readSpy = vi.spyOn(fsp, "readFile").mockImplementation(async (file: any, ...args: any[]) => {
        if (typeof file === "string") accessedPaths.push(file);
        return realReadFile(file, ...args);
      });
      const realReadFileSync = fs.readFileSync;
      const readSyncSpy = vi.spyOn(fs, "readFileSync").mockImplementation((file: any, ...args: any[]) => {
        if (typeof file === "string") accessedPaths.push(file);
        return realReadFileSync(file, ...args);
      });
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(LIVE_BODY), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      try {
        const statBefore = await fsp.stat(opencodeAuth);
        const quota = await opencodeGoAdapter.poll();
        expect(quota.provider).toBe("opencode-go");
        expect(quota.usedPct).toBe(8);
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-dummy-go");

        // Reads land on the consented path only; everything else stays clean.
        expect(accessedPaths).toContain(opencodeAuth);
        for (const p of accessedPaths) {
          if (p === opencodeAuth) continue;
          for (const pattern of SENSITIVE_PATTERNS) {
            expect(pattern.test(p), `enabled poll unexpectedly accessed sensitive path: ${p}`).toBe(false);
          }
        }

        // Read-only: mtime and mode unchanged, no sibling files created.
        const statAfter = await fsp.stat(opencodeAuth);
        expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
        expect(statAfter.mode & 0o777).toBe(statBefore.mode & 0o777);
        const dirEntries = await fsp.readdir(path.dirname(opencodeAuth));
        expect(dirEntries).toEqual(["auth.json"]);
      } finally {
        vi.unstubAllGlobals();
        readSpy.mockRestore();
        readSyncSpy.mockRestore();
        homedirSpy.mockRestore();
        process.env.HOME = origHome;
        if (origQcHome === undefined) delete process.env.QUOTACAP_HOME;
        else process.env.QUOTACAP_HOME = origQcHome;
        if (origEnvKey === undefined) delete process.env.OPENCODE_API_KEY;
        else process.env.OPENCODE_API_KEY = origEnvKey;
        await fsp.rm(mockHome, { recursive: true, force: true });
      }
    });

    it("catalog fetchers spawn CLIs only and never read credential or vendor-cache paths", async () => {
      const mockHome = await fsp.mkdtemp(path.join(os.tmpdir(), "qc-cathome-"));

      const accessedPaths: string[] = [];
      const readSpy = vi.spyOn(fsp, "readFile").mockImplementation(async (file: any, ...args: any[]) => {
        if (typeof file === "string") accessedPaths.push(file);
        return (fsp.readFile as any).wrappedMethod ? (fsp.readFile as any).wrappedMethod(file, ...args) : "";
      });
      const readSyncSpy = vi.spyOn(fs, "readFileSync").mockImplementation((file: any, ...args: any[]) => {
        if (typeof file === "string") accessedPaths.push(file);
        return (fs.readFileSync as any).wrappedMethod ? (fs.readFileSync as any).wrappedMethod(file, ...args) : "";
      });

      // Every catalog exec must carry a catalog-owned abort signal; the mock
      // fails loud if a fetcher ever falls back to the usage-poll default.
      const execSpy = vi.spyOn(spawn, "trackedExecFile").mockImplementation(async (id, _file, args, opts) => {
        expect(opts?.signal).toBeDefined();
        switch (id) {
          case "agy":
            expect(args).toEqual(["models"]);
            return {
              stdout:
                "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n" +
                "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n",
              stderr: "",
            };
          case "claude":
            expect(args).toEqual(["-p", "/model", "--output-format", "json"]);
            return {
              stdout: JSON.stringify({
                num_turns: 0,
                total_cost_usd: 0,
                result:
                  "Current model: `Opus 5`\n" +
                  "Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.",
              }),
              stderr: "",
            };
          case "codex":
            expect(args).toEqual(["debug", "models"]);
            return {
              stdout: JSON.stringify({
                models: [
                  {
                    slug: "gpt-6-astra",
                    display_name: "GPT-6-Astra",
                    visibility: "list",
                    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
                  },
                  { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" },
                ],
              }),
              stderr: "",
            };
          case "grok":
            expect(args).toEqual(["models"]);
            return {
              stdout: "You are logged in with grok.com.\n\nAvailable models:\n* grok-4.6 (default)\n- grok-4.5\n",
              stderr: "",
            };
          case "kimi":
            expect(args).toEqual(["provider", "list", "--json"]);
            return {
              stdout: JSON.stringify({
                models: { "kimi-code/k3": { model: "k3", displayName: "K3", supportEfforts: ["low", "high"] } },
              }),
              stderr: "",
            };
          default:
            throw new Error(`unexpected catalog exec: ${id}`);
        }
      });

      const runPtySpy = vi.spyOn(pty, "runPty").mockImplementation(async (opts) => {
        if (opts.file === "muse") {
          expect(opts.input).toBe("/model");
          expect(opts.cwd).toBe(path.join(mockHome, ".quotacap", "muse-probe"));
          expect(opts.signal).toBeDefined();
          return (
            "Muse Code 2.1 · High Usage · muse-spark-1.3·max\n\n> /model\n\nChoose model\n" +
            "  ❯ muse-spark-1.3\n    muse-spark-1.3-contributor\n    muse-spark-1.2\n    muse-spark-1.2-contributor\n"
          );
        }
        throw new Error(`Unexpected pty file: ${opts.file}`);
      });

      const origHome = process.env.HOME;
      const origQcHome = process.env.QUOTACAP_HOME;
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(mockHome);
      process.env.HOME = mockHome;
      delete process.env.QUOTACAP_HOME;

      try {
        const agy = await catalogFetchers.agy.fetch();
        expect(agy.agy.map((m) => m.id)).toEqual(["gemini-3.8-flash-high"]);
        expect(agy["agy:3p"].map((m) => m.id)).toEqual(["claude-opus-4-6-thinking"]);

        const claude = await catalogFetchers.claude.fetch();
        expect(claude.claude.map((m) => m.id)).toContain("opus");
        expect(claude.claude.find((m) => m.id === "opus")?.default).toBe(true);

        const codex = await catalogFetchers.codex.fetch();
        expect(codex.codex.map((m) => m.id)).toEqual(["gpt-6-astra"]);

        const grok = await catalogFetchers.grok.fetch();
        expect(grok.grok.map((m) => m.id)).toEqual(["grok-4.6", "grok-4.5"]);

        const kimi = await catalogFetchers.kimi.fetch();
        expect(kimi.kimi.map((m) => m.id)).toEqual(["k3"]);

        const muse = await catalogFetchers.muse.fetch();
        expect(muse.muse.map((m) => m.id)).toEqual([
          "muse-spark-1.3",
          "muse-spark-1.3-contributor",
          "muse-spark-1.2",
          "muse-spark-1.2-contributor",
        ]);

        for (const p of accessedPaths) {
          for (const pattern of SENSITIVE_PATTERNS) {
            expect(pattern.test(p), `catalog fetch() unexpectedly accessed sensitive path: ${p}`).toBe(false);
          }
        }
      } finally {
        readSpy.mockRestore();
        readSyncSpy.mockRestore();
        execSpy.mockRestore();
        runPtySpy.mockRestore();
        homedirSpy.mockRestore();
        process.env.HOME = origHome;
        if (origQcHome === undefined) delete process.env.QUOTACAP_HOME;
        else process.env.QUOTACAP_HOME = origQcHome;
        await fsp.rm(mockHome, { recursive: true, force: true });
      }
    });
  });
});

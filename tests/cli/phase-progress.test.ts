import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Command } from "commander";
import { registerUpdateCommand } from "../../src/cli/update.js";
import { launchWeb, waitForInitialPoll } from "../../src/cli/runtime.js";
import { registerModelsCommand } from "../../src/cli/models.js";
import { takeoverManaged, takeoverUnmanaged } from "../../src/cli/takeover.js";
import { ServiceUnavailable } from "../../src/runtime/client.js";
import { registerClientCommands } from "../../src/cli/clients.js";
import { VERSION } from "../../src/version.js";
import { start as startMacos, restart as restartMacos } from "../../src/service/macos.js";
import { start as startSystemd, restart as restartSystemd } from "../../src/service/systemd.js";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const savedHome = process.env.QUOTACAP_HOME;
const dirs: string[] = [];

describe("CLI phase progress integration", () => {
  beforeEach(() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "qc-progress-test-"));
    dirs.push(d);
    process.env.QUOTACAP_HOME = d;
  });

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    if (savedHome === undefined) delete process.env.QUOTACAP_HOME;
    else process.env.QUOTACAP_HOME = savedHome;
    vi.restoreAllMocks();
  });

  describe("quotacap update", () => {
    it("emits resolving, downloading, and takeover progress when interactive", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      const fetchFn = (async (url: any) => {
        const u = String(url);
        if (u.includes("releases/latest")) {
          return {
            status: 302,
            headers: new Headers({ location: "https://github.com/carlosboeing/quotacap/releases/tag/v99.0.0" }),
          };
        }
        if (u.endsWith("/SHA256SUMS")) {
          return { ok: true, text: async () => "fake-checksum  quotacap-darwin-arm64.tar.gz\n" };
        }
        return { ok: true, arrayBuffer: async () => Buffer.from("fake") };
      }) as unknown as typeof fetch;

      const program = new Command();
      registerUpdateCommand(program, {
        execPath: "/usr/local/bin/quotacap",
        channelEnv: { argv1: "/usr/local/bin/quotacap", execPath: "/usr/local/bin/quotacap" },
        fetchFn,
        phase: testPhase,
        extractTar: () => {},
        createClient: () => ({
          get: async () => ({ ok: false }),
          post: async () => ({ ok: true }),
        } as any),
        exit: () => {},
      });

      // Mock updateStandalone
      await program.parseAsync(["node", "quotacap", "update"]);

      expect(phases).toContain("resolving latest version…");
      expect(phases).toContain("downloading 99.0.0…");
    });

    it("suppresses progress on --check", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      const fetchFn = (async (url: any) => {
        return {
          status: 302,
          headers: new Headers({ location: "https://github.com/carlosboeing/quotacap/releases/tag/v99.0.0" }),
        };
      }) as unknown as typeof fetch;

      const program = new Command();
      registerUpdateCommand(program, {
        channelEnv: { argv1: "/usr/local/bin/quotacap", execPath: "/usr/local/bin/quotacap" },
        fetchFn,
        phase: testPhase,
        exit: () => {},
      });

      await program.parseAsync(["node", "quotacap", "update", "--check"]);
      expect(phases).toEqual([]);
    });

    it("suppresses progress on --json", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string, opts?: any) => {
        if (!opts?.json) phases.push(msg);
      };

      const fetchFn = (async () => {
        return {
          status: 302,
          headers: new Headers({ location: "https://github.com/carlosboeing/quotacap/releases/tag/v99.0.0" }),
        };
      }) as unknown as typeof fetch;

      const program = new Command();
      registerUpdateCommand(program, {
        channelEnv: { argv1: "/usr/local/bin/quotacap", execPath: "/usr/local/bin/quotacap" },
        fetchFn,
        phase: testPhase,
        exit: () => {},
      });

      await program.parseAsync(["node", "quotacap", "update", "--json"]);
      expect(phases).toEqual([]);
    });

    it("suppresses resolving version progress when --to is specified", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      const fetchFn = (async () => {
        return {
          ok: true,
          status: 200,
          text: async () => "fake",
          arrayBuffer: async () => Buffer.from("fake"),
        };
      }) as unknown as typeof fetch;

      const program = new Command();
      registerUpdateCommand(program, {
        execPath: "/usr/local/bin/quotacap",
        channelEnv: { argv1: "/usr/local/bin/quotacap", execPath: "/usr/local/bin/quotacap" },
        fetchFn,
        phase: testPhase,
        extractTar: () => {},
        createClient: () => ({
          get: async () => ({ ok: false }),
          post: async () => ({ ok: true }),
        } as any),
        exit: () => {},
      });

      await program.parseAsync(["node", "quotacap", "update", "--to", "99.0.0"]);
      expect(phases).not.toContain("resolving latest version…");
      expect(phases).toContain("downloading 99.0.0…");
    });
  });

  describe("quotacap web and initial poll", () => {
    it("emits waiting for daemon during cold service start and waiting for first readings during initial poll", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      let healthCalls = 0;
      const fakeClient = {
        get: async (url: string) => {
          healthCalls++;
          if (url === "/health") {
            // First call in launchWeb: offline
            if (healthCalls === 1) throw new ServiceUnavailable("offline");
            // Next call in waitForHealthy: ok
            if (healthCalls === 2) return { ok: true, ready: true, version: VERSION };
            // Next call in waitForInitialPoll: in-progress
            if (healthCalls === 3) return { ok: true, polling: "in-progress", lastCompletedPollAt: null };
            // Next call in waitForInitialPoll: settled
            return { ok: true, polling: "idle", lastCompletedPollAt: "2026-09-23T00:00:00Z" };
          }
          return {};
        },
      };

      await launchWeb(
        { open: false },
        {
          createClient: () => fakeClient as any,
          isInstalled: async () => true,
          execService: async () => 0,
          takeoverOpts: {
            sleep: async () => {},
            timeoutMs: 1000,
          },
          openBrowser: async () => {},
          phase: testPhase,
        },
      );

      expect(phases).toContain("waiting for daemon…");
      expect(phases).toContain("waiting for first readings…");
    });

    it("suppresses progress on fast path when daemon is already healthy and poll completed", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      const fakeClient = {
        get: async (url: string) => {
          if (url === "/health") {
            return { ok: true, ready: true, version: VERSION, polling: "idle", lastCompletedPollAt: "2026-09-23T00:00:00Z" };
          }
          return {};
        },
      };

      await launchWeb(
        { open: false },
        {
          createClient: () => fakeClient as any,
          openBrowser: async () => {},
          phase: testPhase,
        },
      );

      expect(phases).toEqual([]);
    });

    it("waitForInitialPoll emits progress only when polling is still in-progress", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      let step = 0;
      const fakeClient = {
        get: async () => {
          step++;
          if (step === 1) return { ok: true, polling: "in-progress", lastCompletedPollAt: null };
          return { ok: true, polling: "idle", lastCompletedPollAt: "2026-09-23T00:00:00Z" };
        },
      };

      await waitForInitialPoll(8787, {
        createClient: () => fakeClient as any,
        sleep: async () => {},
        phase: testPhase,
      });

      expect(phases).toEqual(["waiting for first readings…"]);
    });
  });

  describe("service lifecycle progress", () => {
    // Outlasts the 250ms grace window, so the wait counts as a real one.
    const slowReady = () => new Promise<boolean>((r) => setTimeout(() => r(true), 300));

    it("macos start emits waiting for daemon…", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      await startMacos({
        platform: "darwin",
        runLaunchctl: () => "",
        waitReady: slowReady,
        phase: testPhase,
      });

      expect(phases).toEqual(["waiting for daemon…"]);
    });

    it("macos start stays silent when the service is already ready", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      await startMacos({
        platform: "darwin",
        runLaunchctl: () => "",
        waitReady: async () => true,
        phase: testPhase,
      });

      expect(phases).toEqual([]);
    });

    it("macos restart emits waiting for daemon to stop… then waiting for daemon…", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      await restartMacos({
        platform: "darwin",
        runLaunchctl: () => "",
        waitReleased: async () => true,
        waitReady: slowReady,
        phase: testPhase,
      });

      expect(phases).toEqual(["waiting for daemon to stop…", "waiting for daemon…"]);
    });

    it("systemd start emits waiting for daemon…", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      await startSystemd({
        platform: "linux",
        runSystemctl: () => "",
        waitReady: slowReady,
        phase: testPhase,
      });

      expect(phases).toEqual(["waiting for daemon…"]);
    });

    it("systemd start stays silent when the service is already ready", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      await startSystemd({
        platform: "linux",
        runSystemctl: () => "",
        waitReady: async () => true,
        phase: testPhase,
      });

      expect(phases).toEqual([]);
    });

    it("systemd restart emits waiting for daemon to stop… then waiting for daemon…", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      await restartSystemd({
        platform: "linux",
        runSystemctl: () => "",
        waitReleased: async () => true,
        waitReady: slowReady,
        phase: testPhase,
      });

      expect(phases).toEqual(["waiting for daemon to stop…", "waiting for daemon…"]);
    });

    it("suppresses service progress when quiet is true", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string, opts?: any) => {
        if (!opts?.quiet) phases.push(msg);
      };

      await startMacos({
        platform: "darwin",
        runLaunchctl: () => "",
        waitReady: () => new Promise<boolean>((r) => setTimeout(() => r(true), 300)),
        quiet: true,
        phase: testPhase,
      });

      expect(phases).toEqual([]);
    });
  });

  describe("quotacap models", () => {
    it("emits refreshing model catalogs… when --refresh is passed", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      const fakeClient = {
        post: async () => ({ models: [] }),
      };

      const program = new Command();
      registerModelsCommand(program, {
        createClient: () => fakeClient as any,
        phase: testPhase,
      });

      await program.parseAsync(["node", "quotacap", "models", "--refresh"]);
      expect(phases).toEqual(["refreshing model catalogs…"]);
    });

    it("suppresses progress on models --refresh --json", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string, opts?: any) => {
        if (!opts?.json) phases.push(msg);
      };

      const fakeClient = {
        post: async () => ({ models: [] }),
      };

      const program = new Command();
      registerModelsCommand(program, {
        createClient: () => fakeClient as any,
        phase: testPhase,
      });

      await program.parseAsync(["node", "quotacap", "models", "--refresh", "--json"]);
      expect(phases).toEqual([]);
    });

    it("does not emit progress on models without --refresh", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      const fakeClient = {
        get: async () => ({ models: [] }),
      };

      const program = new Command();
      registerModelsCommand(program, {
        createClient: () => fakeClient as any,
        phase: testPhase,
      });

      await program.parseAsync(["node", "quotacap", "models"]);
      expect(phases).toEqual([]);
    });
  });

  describe("takeover progress", () => {
    it("takeoverManaged emits waiting for daemon…", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      await takeoverManaged({
        port: 8787,
        health: { version: "0.0.39" },
        cliVersion: "0.0.40",
        execService: async () => 0,
        createClient: () => ({
          get: async () => ({ ok: true, ready: true, version: "0.0.40" }),
        } as any),
        phase: testPhase,
      });

      expect(phases).toEqual(["waiting for daemon…"]);
    });

    it("takeoverManaged silences the nested service restart's own progress", async () => {
      let nestedOpts: Record<string, any> | undefined;
      await takeoverManaged({
        port: 8787,
        health: { version: "0.0.39" },
        cliVersion: "0.0.40",
        execService: async (_args, o) => {
          nestedOpts = o;
          return 0;
        },
        createClient: () => ({
          get: async () => ({ ok: true, ready: true, version: "0.0.40" }),
        } as any),
        phase: () => {},
      });

      const writer = vi.fn();
      nestedOpts?.phase("waiting for daemon to stop…", { isTTY: true, stderr: writer });
      expect(typeof nestedOpts?.phase).toBe("function");
      expect(writer).not.toHaveBeenCalled();
    });

    for (const command of ["status", "advise"]) {
      it(`${command} --json suppresses managed takeover progress`, async () => {
        const calls: Array<{ msg: string; json?: boolean }> = [];
        let upgraded = false;
        const program = new Command();
        registerClientCommands(program, {
          createClient: () => ({
            get: async (url: string) => {
              if (url === "/health") {
                return upgraded
                  ? { ok: true, ready: true, version: VERSION }
                  : { ok: true, ready: true, version: "0.0.1" };
              }
              throw new ServiceUnavailable("offline");
            },
          } as any),
          isManaged: async () => true,
          execService: async () => {
            upgraded = true;
            return 0;
          },
          takeoverOpts: {
            sleep: async () => {},
            timeoutMs: 1000,
            phase: (msg, opts) => calls.push({ msg, json: opts?.json }),
          },
          checkUpdates: async () => null,
          exit: () => {},
        });
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});

        await program.parseAsync(["node", "quotacap", command, "--json"]);

        expect(calls).toEqual([{ msg: "waiting for daemon…", json: true }]);
      });
    }

    it("takeoverUnmanaged emits waiting for daemon to stop…", async () => {
      const phases: string[] = [];
      const testPhase = (msg: string) => phases.push(msg);

      let stopped = false;
      await takeoverUnmanaged({
        port: 8787,
        health: { version: "0.0.39" },
        cliVersion: "0.0.40",
        readToken: () => "fake-token",
        createClient: () => ({
          post: async () => ({ ok: true }),
          get: async () => {
            if (!stopped) {
              stopped = true;
              throw new Error("connection refused");
            }
            throw new Error("connection refused");
          },
        } as any),
        sleep: async () => {},
        phase: testPhase,
      });

      expect(phases).toEqual(["waiting for daemon to stop…"]);
    });
  });
});

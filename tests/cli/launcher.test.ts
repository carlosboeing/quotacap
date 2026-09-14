import { describe, it, expect, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { launchWeb, type RuntimeCommandDeps } from "../../src/cli/runtime.js";
import { startDaemon, type ServiceHandle } from "../../src/daemon.js";
import { ServiceUnavailable } from "../../src/runtime/client.js";
import { VERSION } from "../../src/version.js";
import { runCli } from "./helpers.js";

const exec = promisify(execFile);
const handles: ServiceHandle[] = [];
const prevHome = process.env.QUOTACAP_HOME;
let home = "";

afterEach(async () => {
  for (const h of handles.splice(0)) {
    try {
      await h.stop();
    } catch {
      /* already stopped */
    }
  }
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.QUOTACAP_HOME;
  else process.env.QUOTACAP_HOME = prevHome;
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = "";
});

function isolatedHome(): string {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "qc-launcher-"));
  process.env.QUOTACAP_HOME = home;
  return home;
}

function dataDir(): string {
  return path.join(home, ".quotacap");
}

function writeFreshClaim(): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir(), "service.lock"),
    JSON.stringify({
      nonce: "test",
      pid: 424242,
      startedAt: new Date().toISOString(),
      version: VERSION,
      exec: "/test/quotacap",
      lastBeat: new Date().toISOString(),
    }),
  );
}

function stderrOf(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((c) => String(c[0])).join("\n");
}

const noUpdateCheck = async () => {};
const healthy = { ok: true, ready: true, version: VERSION, exec: process.execPath };

// launchWeb decision order, exercised through the injected-deps seam:
// healthy daemons open (with takeover when the CLI is newer), a fresh
// claim with nothing answering exits 2, registered-but-down services
// start, and only the last resort foreground-starts.
describe("launchWeb branches", () => {
  it("opens a healthy matching daemon without starting anything", async () => {
    isolatedHome();
    const openBrowser = vi.fn();
    const startService = vi.fn();
    const exit = vi.fn();
    await launchWeb(
      {},
      {
        createClient: (() => ({ get: async () => healthy })) as unknown as RuntimeCommandDeps["createClient"],
        openBrowser,
        startService: startService as unknown as RuntimeCommandDeps["startService"],
        exit,
        checkUpdates: noUpdateCheck,
      },
    );
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledWith("http://127.0.0.1:8787");
    expect(startService).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("prints the URL without opening a browser when open is false", async () => {
    isolatedHome();
    const openBrowser = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await launchWeb(
      { open: false },
      {
        createClient: (() => ({ get: async () => healthy })) as unknown as RuntimeCommandDeps["createClient"],
        openBrowser,
        checkUpdates: noUpdateCheck,
      },
    );
    expect(openBrowser).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("http://127.0.0.1:8787");
  });

  it("prints the URL without opening a browser when QUOTACAP_NO_OPEN=1", async () => {
    isolatedHome();
    process.env.QUOTACAP_NO_OPEN = "1";
    try {
      const openBrowser = vi.fn();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await launchWeb(
        {},
        {
          createClient: (() => ({ get: async () => healthy })) as unknown as RuntimeCommandDeps["createClient"],
          openBrowser,
          checkUpdates: noUpdateCheck,
        },
      );
      expect(openBrowser).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith("http://127.0.0.1:8787");
    } finally {
      delete process.env.QUOTACAP_NO_OPEN;
    }
  });

  it("takes over a healthy older unmanaged daemon, then opens the successor", async () => {
    isolatedHome();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let gets = 0;
    const client = {
      get: async () => {
        gets += 1;
        if (gets === 1) return { ok: true, ready: true, version: "0.0.1", exec: "/old/quotacap" };
        throw new ServiceUnavailable();
      },
      post: async () => ({ ok: true, restarting: true, version: VERSION, pid: 1 }),
    };
    const openBrowser = vi.fn();
    await launchWeb(
      {},
      {
        createClient: (() => client) as unknown as RuntimeCommandDeps["createClient"],
        openBrowser,
        startService: (async () => ({ port: 9999 })) as unknown as RuntimeCommandDeps["startService"],
        isManaged: async () => false,
        checkUpdates: noUpdateCheck,
        takeoverOpts: { sleep: async () => {}, timeoutMs: 1000, readToken: () => "tok" },
      },
    );
    expect(stderrOf(errSpy)).toContain(`Upgraded daemon from 0.0.1 to ${VERSION}`);
    expect(openBrowser).toHaveBeenCalledWith("http://127.0.0.1:9999");
  });

  it("exits 2 with recovery instructions when a live owner holds the install", async () => {
    isolatedHome();
    writeFreshClaim();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.fn();
    await launchWeb(
      {},
      {
        createClient: (() => ({
          get: async () => {
            throw new ServiceUnavailable();
          },
        })) as unknown as RuntimeCommandDeps["createClient"],
        isManaged: async () => false,
        exit,
        checkUpdates: noUpdateCheck,
      },
    );
    expect(exit).toHaveBeenCalledWith(2);
    expect(stderrOf(errSpy)).toContain("existing service mismatch");
  });

  it("starts a registered-but-down service, then opens", async () => {
    isolatedHome();
    let gets = 0;
    const client = {
      get: async () => {
        gets += 1;
        if (gets === 1) throw new ServiceUnavailable();
        return healthy;
      },
    };
    const execService = vi.fn(async () => 0);
    const openBrowser = vi.fn();
    await launchWeb(
      {},
      {
        createClient: (() => client) as unknown as RuntimeCommandDeps["createClient"],
        openBrowser,
        execService,
        isInstalled: async () => true,
        checkUpdates: noUpdateCheck,
        takeoverOpts: { sleep: async () => {}, timeoutMs: 1000 },
      },
    );
    expect(execService).toHaveBeenCalledWith(["start"]);
    expect(openBrowser).toHaveBeenCalledWith("http://127.0.0.1:8787");
  });

  it("foreground-starts with an install suggestion when unregistered", async () => {
    isolatedHome();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const startService = vi.fn(async () => ({ port: 7777 }));
    const openBrowser = vi.fn();
    const isInstalled = vi.fn(async () => false);
    await launchWeb(
      {},
      {
        createClient: (() => ({
          get: async () => {
            throw new ServiceUnavailable();
          },
        })) as unknown as RuntimeCommandDeps["createClient"],
        openBrowser,
        startService: startService as unknown as RuntimeCommandDeps["startService"],
        isInstalled,
        serviceSupported: () => true,
        checkUpdates: noUpdateCheck,
      },
    );
    expect(isInstalled).toHaveBeenCalled();
    expect(startService).toHaveBeenCalledWith(undefined);
    expect(openBrowser).toHaveBeenCalledWith("http://127.0.0.1:7777");
    expect(stderrOf(errSpy)).toContain("quotacap service install");
  });

  it("--port overrides naming a non-config port skip service management", async () => {
    isolatedHome();
    const startService = vi.fn(async () => ({ port: 9999 }));
    const isInstalled = vi.fn(async () => true);
    const openBrowser = vi.fn();
    await launchWeb(
      { port: "9999" },
      {
        createClient: (() => ({
          get: async () => {
            throw new ServiceUnavailable();
          },
        })) as unknown as RuntimeCommandDeps["createClient"],
        openBrowser,
        startService: startService as unknown as RuntimeCommandDeps["startService"],
        isInstalled,
        checkUpdates: noUpdateCheck,
      },
    );
    expect(isInstalled).not.toHaveBeenCalled();
    expect(startService).toHaveBeenCalledWith({ port: 9999 });
    expect(openBrowser).toHaveBeenCalledWith("http://127.0.0.1:9999");
  });

  it("--foreground skips service management and the install suggestion", async () => {
    isolatedHome();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const startService = vi.fn(async () => ({ port: 8787 }));
    const isInstalled = vi.fn(async () => true);
    await launchWeb(
      { foreground: true },
      {
        createClient: (() => ({
          get: async () => {
            throw new ServiceUnavailable();
          },
        })) as unknown as RuntimeCommandDeps["createClient"],
        openBrowser: async () => {},
        startService: startService as unknown as RuntimeCommandDeps["startService"],
        isInstalled,
        checkUpdates: noUpdateCheck,
      },
    );
    expect(isInstalled).not.toHaveBeenCalled();
    expect(startService).toHaveBeenCalledWith(undefined);
    expect(stderrOf(errSpy)).not.toContain("quotacap service install");
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function isolatedHomeWithPort(port: number): string {
  const dir = isolatedHome();
  const d = dataDir();
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "config.json"),
    JSON.stringify({ port, pollMinutes: 60, enabledProviders: ["manual"] }),
  );
  return dir;
}

// Bare `quotacap` routes through the shared launcher; flags keep Commander
// behavior. Black-box runs stay tab-free via QUOTACAP_NO_OPEN / --no-open,
// which print the URL instead of opening the developer's browser.
describe("bare invocation and foreground preservation", () => {
  it("bare quotacap against a healthy daemon exits 0", async () => {
    const port = await freePort();
    const dir = isolatedHomeWithPort(port);
    const daemon = await startDaemon({ port, signals: false });
    handles.push(daemon);
    const res = await runCli(dir, [], { QUOTACAP_NO_OPEN: "1" });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe(`http://127.0.0.1:${port}`);
  });

  it("quotacap --help keeps Commander behavior", async () => {
    const dir = isolatedHome();
    const res = await runCli(dir, ["--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Usage: quotacap");
  });

  it("web --foreground with no daemon holds the terminal", async () => {
    const port = await freePort();
    const dir = isolatedHomeWithPort(port);
    // SIGKILL (not the default SIGTERM, which the daemon handles with a
    // graceful exit 0): only a still-running process can be SIGKILLed.
    let killed = false;
    try {
      await exec("node", ["--no-warnings", "dist/cli/index.js", "web", "--foreground", "--no-open"], {
        timeout: 8000,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --no-warnings`.trim(),
          QUOTACAP_HOME: dir,
        },
      });
    } catch (e: any) {
      killed = e.killed === true && e.signal === "SIGKILL";
    }
    expect(killed).toBe(true);
  }, 20000);
});

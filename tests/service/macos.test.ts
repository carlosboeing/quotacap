import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPlist,
  resolveServiceExec,
  resolveProviderPaths,
  formatMissingProviders,
  install,
  uninstall,
  start,
  stop,
  restart,
  runServiceCommand,
  serviceSupported,
  SERVICE_LABEL,
  type ServiceDeps,
} from "../../src/service/index.js";
import { readServiceMetadata } from "../../src/config.js";
import { VERSION } from "../../src/version.js";

let hasPlutil = false;
try {
  execFileSync("which", ["plutil"], { stdio: "ignore" });
  hasPlutil = true;
} catch {}

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function mkHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "qc-svc-"));
  dirs.push(d);
  return d;
}

interface Recorder {
  calls: string[][];
  failOn?: (args: string[]) => Error | null;
}

function recorder(failOn?: (args: string[]) => Error | null): Recorder & {
  run: (args: string[]) => string;
} {
  const rec: Recorder = { calls: [], failOn };
  return {
    ...rec,
    run: (args: string[]) => {
      rec.calls.push(args);
      const err = failOn?.(args);
      if (err) throw err;
      return "";
    },
  };
}

function depsFor(
  home: string,
  run: (args: string[]) => string,
  over: Partial<ServiceDeps> = {},
): ServiceDeps {
  const printed: string[] = [];
  return {
    platform: "darwin",
    home,
    uid: 501,
    dataDir: path.join(home, ".quotacap"),
    execPath: "/stable/quotacap",
    argv1: undefined,
    runLaunchctl: run,
    which: () => null,
    lintPlist: () => {},
    print: (m: string) => printed.push(m),
    error: (m: string) => printed.push(m),
    printed,
    ...over,
  } as ServiceDeps & { printed: string[] };
}

describe("macos login service", () => {
  it("(a) plist carries the exact service keys", () => {
    const xml = buildPlist({
      label: SERVICE_LABEL,
      argv: ["/stable/quotacap", "daemon", "--foreground"],
      workingDirectory: "/tmp/qc/.quotacap",
      path: "/opt/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      logFile: "/tmp/qc/.quotacap/logs/service.log",
      quotacapHome: "/tmp/qc",
      stdoutPath: "/tmp/qc/.quotacap/logs/service.log",
      stderrPath: "/tmp/qc/.quotacap/logs/service.log",
    });
    for (const needle of [
      "<key>Label</key>",
      "<string>quotacap</string>",
      "<key>ProgramArguments</key>",
      "<string>/stable/quotacap</string>",
      "<string>daemon</string>",
      "<string>--foreground</string>",
      "<key>RunAtLoad</key>",
      "<true/>",
      "<key>KeepAlive</key>",
      "<key>ThrottleInterval</key>",
      "<integer>30</integer>",
      "<key>WorkingDirectory</key>",
      "<string>/tmp/qc/.quotacap</string>",
      "<key>PATH</key>",
      "<key>QUOTACAP_LOG_FILE</key>",
      "<key>QUOTACAP_HOME</key>",
      "<string>/tmp/qc</string>",
      "<key>StandardOutPath</key>",
      "<key>StandardErrorPath</key>",
    ]) {
      expect(xml).toContain(needle);
    }
    // QUOTACAP_HOME only when supplied.
    const bare = buildPlist({
      label: SERVICE_LABEL,
      argv: ["/stable/quotacap", "daemon", "--foreground"],
      workingDirectory: "/tmp/qc/.quotacap",
      path: "/usr/bin:/bin",
      logFile: "/tmp/qc/.quotacap/logs/service.log",
      stdoutPath: "/tmp/qc/.quotacap/logs/service.log",
      stderrPath: "/tmp/qc/.quotacap/logs/service.log",
    });
    expect(bare).not.toContain("QUOTACAP_HOME");
  });

  it.skipIf(!hasPlutil)("plist output passes plutil -lint", () => {
    const dir = mkHome();
    const file = path.join(dir, "quotacap.plist");
    fs.writeFileSync(
      file,
      buildPlist({
        label: SERVICE_LABEL,
        argv: ["/stable/quotacap", "daemon", "--foreground"],
        workingDirectory: path.join(dir, ".quotacap"),
        path: "/usr/bin:/bin:/usr/sbin:/sbin",
        logFile: path.join(dir, ".quotacap", "logs", "service.log"),
        stdoutPath: path.join(dir, ".quotacap", "logs", "service.log"),
        stderrPath: path.join(dir, ".quotacap", "logs", "service.log"),
      }),
    );
    const out = execFileSync("plutil", ["-lint", file], { encoding: "utf8" });
    expect(out).toMatch(/OK/);
  });

  it("(b) exec detection: binary vs node mode", () => {
    const bin = resolveServiceExec({
      execPath: "/usr/local/bin/quotacap",
      argv1: undefined,
    });
    expect(bin.argv).toEqual([
      "/usr/local/bin/quotacap",
      "daemon",
      "--foreground",
    ]);
    expect(bin.entry).toBe("");

    const node = resolveServiceExec({
      execPath: "/usr/local/bin/node",
      argv1: "/stable/quotacap/dist/cli/index.js",
    });
    expect(node.argv).toEqual([
      "/usr/local/bin/node",
      "/stable/quotacap/dist/cli/index.js",
      "daemon",
      "--foreground",
    ]);
    expect(node.entry).toBe("/stable/quotacap/dist/cli/index.js");

    // Relative entry resolves absolute.
    const rel = resolveServiceExec({
      execPath: "/usr/local/bin/node",
      argv1: "dist/cli/index.js",
    });
    expect(path.isAbsolute(rel.entry)).toBe(true);
    expect(rel.argv[1]).toBe(rel.entry);
  });

  it("(c) transient npx and worktree paths are rejected", () => {
    for (const [execPath, argv1] of [
      ["/tmp/x/_npx/abc/quotacap", undefined],
      ["/usr/local/bin/node", "/Users/x/.npm/_npx/abc/dist/cli/index.js"],
      ["/usr/local/bin/node", "/repo/.worktrees/kimi/feat/x/dist/cli/index.js"],
    ] as [string, string | undefined][]) {
      expect(() => resolveServiceExec({ execPath, argv1 })).toThrow(
        /stable install/,
      );
    }
  });

  it("(d) provider resolution records paths, null when missing", () => {
    const paths = resolveProviderPaths({
      which: (bin: string) =>
        bin === "codex" || bin === "agy" ? null : `/opt/bin/${bin}`,
    });
    expect(paths).toEqual({
      claude: "/opt/bin/claude",
      codex: null,
      kimi: "/opt/bin/kimi",
      grok: "/opt/bin/grok",
      agy: null,
      muse: "/opt/bin/muse",
    });
    const hints = formatMissingProviders(paths);
    expect(hints).toHaveLength(2);
    expect(hints.join("\n")).toContain("codex");
    expect(hints.join("\n")).toContain("agy");
    expect(hints.join("\n")).toMatch(/re-run/);
  });

  it("(e) fresh install writes plist+metadata; reinstall is idempotent", async () => {
    const home = mkHome();
    const dataDir = path.join(home, ".quotacap");
    const plistFile = path.join(home, "Library/LaunchAgents/quotacap.plist");
    const rec = recorder();
    const linted: string[] = [];
    const d = depsFor(home, rec.run, {
      which: (bin: string) => `/opt/bin/${bin}`,
      lintPlist: (p: string) => linted.push(p),
    });

    await install(d);
    expect(fs.existsSync(plistFile)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "logs"))).toBe(true);
    expect(linted).toEqual([plistFile]);
    expect(rec.calls).toEqual([
      ["bootstrap", "gui/501", plistFile],
      ["enable", "gui/501/quotacap"],
    ]);
    const meta = readServiceMetadata(dataDir)!;
    expect(meta.version).toBe(VERSION);
    expect(meta.exec).toBe("/stable/quotacap");
    expect(meta.providerPaths.claude).toBe("/opt/bin/claude");
    expect(meta.installedAt).toBeTruthy();
    const serialized = fs.readFileSync(
      path.join(dataDir, "service.json"),
      "utf8",
    );
    for (const secret of ["token", "secret", "credential", "api_key", "BEGIN"]) {
      expect(serialized.toLowerCase()).not.toContain(secret);
    }
    const plistBefore = fs.readFileSync(plistFile, "utf8");

    // Reinstall: no rewrite, still ensured loaded.
    rec.calls.length = 0;
    await install(d);
    expect(rec.calls).toEqual([
      ["bootstrap", "gui/501", plistFile],
      ["enable", "gui/501/quotacap"],
    ]);
    expect(fs.readFileSync(plistFile, "utf8")).toBe(plistBefore);
  });

  it("reinstall after a provider appears refreshes the plist PATH and metadata", async () => {
    const home = mkHome();
    const dataDir = path.join(home, ".quotacap");
    const plistFile = path.join(home, "Library/LaunchAgents/quotacap.plist");
    const rec = recorder();
    // First install: codex is missing.
    await install(
      depsFor(home, rec.run, {
        which: (bin: string) => (bin === "codex" ? null : `/opt/bin/${bin}`),
      }),
    );
    expect(readServiceMetadata(dataDir)?.providerPaths.codex).toBeNull();
    expect(fs.readFileSync(plistFile, "utf8")).not.toContain("/new/bin");

    // codex installed since, same argv and same version: still a rewrite.
    rec.calls.length = 0;
    await install(
      depsFor(home, rec.run, {
        which: (bin: string) =>
          bin === "codex" ? "/new/bin/codex" : `/opt/bin/${bin}`,
      }),
    );
    expect(readServiceMetadata(dataDir)?.providerPaths.codex).toBe("/new/bin/codex");
    expect(fs.readFileSync(plistFile, "utf8")).toContain("/new/bin");
    expect(rec.calls).toEqual([
      ["bootout", "gui/501/quotacap"],
      ["bootstrap", "gui/501", plistFile],
      ["enable", "gui/501/quotacap"],
    ]);
  });

  it("(f) foreign plist at the path is refused", async () => {
    const home = mkHome();
    const plistFile = path.join(home, "Library/LaunchAgents/quotacap.plist");
    fs.mkdirSync(path.dirname(plistFile), { recursive: true });
    fs.writeFileSync(
      plistFile,
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>com.other.thing</string></dict></plist>`,
    );
    const rec = recorder();
    const d = depsFor(home, rec.run);
    await expect(install(d)).rejects.toThrow(/foreign plist/);
    expect(rec.calls).toEqual([]);
    expect(fs.readFileSync(plistFile, "utf8")).toContain("com.other.thing");
  });

  it("(g) upgrade refreshes metadata and reloads the job", async () => {
    const home = mkHome();
    const dataDir = path.join(home, ".quotacap");
    const plistFile = path.join(home, "Library/LaunchAgents/quotacap.plist");
    fs.mkdirSync(path.dirname(plistFile), { recursive: true });
    fs.writeFileSync(
      plistFile,
      buildPlist({
        label: SERVICE_LABEL,
        argv: ["/old/quotacap", "daemon", "--foreground"],
        workingDirectory: dataDir,
        path: "/usr/bin:/bin",
        logFile: path.join(dataDir, "logs", "service.log"),
        stdoutPath: path.join(dataDir, "logs", "service.log"),
        stderrPath: path.join(dataDir, "logs", "service.log"),
      }),
    );
    const rec = recorder();
    const d = depsFor(home, rec.run, {
      which: (bin: string) => `/opt/bin/${bin}`,
    });
    await install(d);
    expect(rec.calls).toEqual([
      ["bootout", "gui/501/quotacap"],
      ["bootstrap", "gui/501", plistFile],
      ["enable", "gui/501/quotacap"],
    ]);
    expect(fs.readFileSync(plistFile, "utf8")).toContain("/stable/quotacap");
    expect(readServiceMetadata(dataDir)?.version).toBe(VERSION);

    // bootout of a non-loaded job does not block the upgrade.
    const rec2 = recorder((args) =>
      args[0] === "bootout" ? new Error("Could not find service") : null,
    );
    fs.writeFileSync(
      plistFile,
      buildPlist({
        label: SERVICE_LABEL,
        argv: ["/older/quotacap", "daemon", "--foreground"],
        workingDirectory: dataDir,
        path: "/usr/bin:/bin",
        logFile: path.join(dataDir, "logs", "service.log"),
        stdoutPath: path.join(dataDir, "logs", "service.log"),
        stderrPath: path.join(dataDir, "logs", "service.log"),
      }),
    );
    await install(depsFor(home, rec2.run));
    expect(rec2.calls[0][0]).toBe("bootout");
    expect(rec2.calls).toContainEqual(["bootstrap", "gui/501", plistFile]);
    expect(rec2.calls).toContainEqual(["enable", "gui/501/quotacap"]);
  });

  it("(h) uninstall removes only the plist", async () => {
    const home = mkHome();
    const dataDir = path.join(home, ".quotacap");
    const plistFile = path.join(home, "Library/LaunchAgents/quotacap.plist");
    fs.mkdirSync(path.dirname(plistFile), { recursive: true });
    fs.writeFileSync(plistFile, buildPlist({
      label: SERVICE_LABEL,
      argv: ["/stable/quotacap", "daemon", "--foreground"],
      workingDirectory: dataDir,
      path: "/usr/bin:/bin",
      logFile: path.join(dataDir, "logs", "service.log"),
      stdoutPath: path.join(dataDir, "logs", "service.log"),
      stderrPath: path.join(dataDir, "logs", "service.log"),
    }));
    fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "config.json"), "{}");
    fs.writeFileSync(path.join(dataDir, "quotacap.db"), "db");
    fs.writeFileSync(path.join(dataDir, "logs", "service.log"), "logs");
    const rec = recorder();
    await uninstall(depsFor(home, rec.run));
    expect(rec.calls).toEqual([["bootout", "gui/501/quotacap"]]);
    expect(fs.existsSync(plistFile)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "quotacap.db"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "logs", "service.log"))).toBe(true);
  });

  it("start/stop/restart drive launchctl", async () => {
    const home = mkHome();
    const rec = recorder();
    const d = depsFor(home, rec.run, { waitReady: async () => true });
    await start(d);
    expect(rec.calls).toEqual([
      ["bootstrap", `gui/501`, path.join(home, "Library/LaunchAgents/quotacap.plist")],
      ["enable", "gui/501/quotacap"],
    ]);
    await stop(depsFor(home, rec.run));
    expect(rec.calls.at(-1)).toEqual(["bootout", "gui/501/quotacap"]);
    rec.calls.length = 0;
    await restart(depsFor(home, rec.run, { waitReady: async () => true, waitReleased: async () => true }));
    expect(rec.calls).toEqual([
      ["bootout", "gui/501/quotacap"],
      ["bootstrap", `gui/501`, path.join(home, "Library/LaunchAgents/quotacap.plist")],
      ["enable", "gui/501/quotacap"],
    ]);
  });

  // `launchctl bootout` returns before the job is gone. Starting immediately
  // raced the dying process for the port, and `quotacap update` reported
  // "service did not become ready on port 8787" on a perfectly good upgrade.
  it("restart waits for the port to be released before starting again", async () => {
    const home = mkHome();
    const rec = recorder();
    const order: string[] = [];
    const run = (args: string[]) => {
      order.push(args[0]);
      return rec.run(args);
    };
    await restart(
      depsFor(home, run, {
        waitReady: async () => true,
        waitReleased: async () => {
          order.push("wait-released");
          return true;
        },
      }),
    );
    expect(order).toEqual(["bootout", "wait-released", "bootstrap", "enable"]);
  });

  it("restart starts anyway, with a warning, when the port never frees", async () => {
    const home = mkHome();
    const rec = recorder();
    const printed: string[] = [];
    await restart(
      depsFor(home, rec.run, {
        waitReady: async () => true,
        waitReleased: async () => false,
        print: (m: string) => printed.push(m),
      }),
    );
    expect(printed.some((m) => /still in use/.test(m))).toBe(true);
    expect(rec.calls.map((c) => c[0])).toEqual(["bootout", "bootstrap", "enable"]);
  });

  it("upgrade retries bootstrap across the teardown window, then loads", async () => {
    const home = mkHome();
    const dataDir = path.join(home, ".quotacap");
    const plistFile = path.join(home, "Library/LaunchAgents/quotacap.plist");
    fs.mkdirSync(path.dirname(plistFile), { recursive: true });
    fs.writeFileSync(
      plistFile,
      buildPlist({
        label: SERVICE_LABEL,
        argv: ["/old/quotacap", "daemon", "--foreground"],
        workingDirectory: dataDir,
        path: "/usr/bin:/bin",
        logFile: path.join(dataDir, "logs", "service.log"),
        stdoutPath: path.join(dataDir, "logs", "service.log"),
        stderrPath: path.join(dataDir, "logs", "service.log"),
      }),
    );
    // bootout returns before the record clears: the first bootstrap hits
    // error 5 while `print` already reports the job gone, so the retry wins.
    const calls: string[][] = [];
    let bootstraps = 0;
    const run = (args: string[]): string => {
      calls.push(args);
      if (args[0] === "bootstrap") {
        bootstraps += 1;
        if (bootstraps === 1) throw new Error("launchctl bootstrap failed: Bootstrap failed: 5: Input/output error");
        return "";
      }
      if (args[0] === "print") throw new Error("Could not find service");
      return "";
    };
    const sleeps: number[] = [];
    await install(
      depsFor(home, run, {
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      }),
    );
    expect(bootstraps).toBe(2);
    expect(sleeps.length).toBe(1);
    expect(calls).toContainEqual(["bootout", "gui/501/quotacap"]);
    expect(calls).toContainEqual(["print", "gui/501/quotacap"]);
    expect(calls).toContainEqual(["enable", "gui/501/quotacap"]);
    expect(fs.readFileSync(plistFile, "utf8")).toContain("/stable/quotacap");
  });

  it("start treats an already-loaded bootstrap failure as success", async () => {
    const home = mkHome();
    // Error 5 with the job loaded is the steady state (start ran twice):
    // no retry storm, just enable and report ready.
    const calls: string[][] = [];
    const run = (args: string[]): string => {
      calls.push(args);
      if (args[0] === "bootstrap") throw new Error("launchctl bootstrap failed: Bootstrap failed: 5: Input/output error");
      return "";
    };
    const sleeps: number[] = [];
    const d = depsFor(home, run, {
      waitReady: async () => true,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    await start(d);
    expect(calls).toEqual([
      ["bootstrap", "gui/501", path.join(home, "Library/LaunchAgents/quotacap.plist")],
      ["print", "gui/501/quotacap"],
      ["enable", "gui/501/quotacap"],
    ]);
    expect(sleeps).toEqual([]);
    expect((d as unknown as { printed: string[] }).printed.join("\n")).toContain(
      "service started and ready",
    );
  });

  it("persistent bootstrap failure exhausts the deadline and throws", async () => {
    const home = mkHome();
    const run = (args: string[]): string => {
      if (args[0] === "bootstrap") throw new Error("launchctl bootstrap failed: Bootstrap failed: 5: Input/output error");
      if (args[0] === "print") throw new Error("Could not find service");
      return "";
    };
    await expect(
      start(
        depsFor(home, run, {
          waitReady: async () => true,
          sleep: async () => {},
          bootstrapTimeoutMs: 60,
        }),
      ),
    ).rejects.toThrow(/Bootstrap failed: 5/);
  });

  it("non-5 bootstrap errors throw immediately without probing", async () => {
    const home = mkHome();
    const calls: string[][] = [];
    const run = (args: string[]): string => {
      calls.push(args);
      if (args[0] === "bootstrap") throw new Error("launchctl bootstrap failed: Bootstrap failed: 110: Data flop");
      return "";
    };
    await expect(
      start(depsFor(home, run, { waitReady: async () => true, sleep: async () => {} })),
    ).rejects.toThrow(/Bootstrap failed: 110/);
    expect(calls).toEqual([
      ["bootstrap", "gui/501", path.join(home, "Library/LaunchAgents/quotacap.plist")],
    ]);
  });

  it("(i) unsupported platform prints guidance and touches nothing", async () => {
    const home = mkHome();
    const plistFile = path.join(home, "Library/LaunchAgents/quotacap.plist");
    for (const verb of ["install", "uninstall", "start", "stop", "restart"]) {
      const rec = recorder();
      const d = depsFor(home, rec.run, { platform: "win32" });
      const code = await runServiceCommand(
        [verb],
        {},
        d as ServiceDeps & { printed: string[] },
      );
      expect(code).toBe(2);
      expect(
        (d as unknown as { printed: string[] }).printed.join("\n"),
      ).toMatch(/foreground/);
      expect(
        (d as unknown as { printed: string[] }).printed.join("\n"),
      ).toMatch(/macOS and Linux/);
      expect(rec.calls).toEqual([]);
      expect(fs.existsSync(plistFile)).toBe(false);
    }
    expect(serviceSupported("win32")).toBe(false);
    expect(serviceSupported("darwin")).toBe(true);
    expect(serviceSupported("linux")).toBe(true);
  });
});

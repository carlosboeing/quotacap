import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildUnit,
  collectStatus,
  formatSystemctlError,
  install,
  isOurUnit,
  restart,
  SERVICE_UNIT,
  start,
  stop,
  uninstall,
  type SystemdDeps,
} from "../../src/service/systemd.js";
import {
  isServiceManaged,
  runServiceCommand,
  serviceSupported,
} from "../../src/service/index.js";
import { readServiceMetadata } from "../../src/config.js";
import { VERSION } from "../../src/version.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function mkHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "qc-svc-linux-"));
  dirs.push(d);
  return d;
}

interface Recorder {
  calls: string[][];
  failOn?: (args: string[]) => Error | null;
  respond?: (args: string[]) => string;
}

function recorder(
  failOn?: (args: string[]) => Error | null,
  respond?: (args: string[]) => string,
): Recorder & { run: (args: string[]) => string } {
  const rec: Recorder = { calls: [], failOn, respond };
  return {
    ...rec,
    run: (args: string[]) => {
      rec.calls.push(args);
      const err = failOn?.(args);
      if (err) throw err;
      return respond?.(args) ?? "";
    },
  };
}

function depsFor(
  home: string,
  run: (args: string[]) => string,
  over: Partial<SystemdDeps> = {},
): SystemdDeps {
  const printed: string[] = [];
  return {
    platform: "linux",
    home,
    uid: 1000,
    dataDir: path.join(home, ".quotacap"),
    port: 1,
    execPath: "/stable/quotacap",
    argv1: undefined,
    runSystemctl: run,
    which: () => null,
    waitReady: async () => true,
    waitReleased: async () => true,
    print: (m: string) => printed.push(m),
    error: (m: string) => printed.push(m),
    printed,
    ...over,
  } as SystemdDeps & { printed: string[] };
}

function unitFile(home: string): string {
  return path.join(home, ".config", "systemd", "user", SERVICE_UNIT);
}

describe("systemd user service", () => {
  it("(a) unit carries the exact service keys", () => {
    const unit = buildUnit({
      argv: ["/stable/quotacap", "daemon", "--foreground"],
      workingDirectory: "/tmp/qc/.quotacap",
      path: "/opt/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      logFile: "/tmp/qc/.quotacap/logs/service.log",
      quotacapHome: "/tmp/qc",
    });
    for (const needle of [
      "[Unit]",
      "Description=QuotaCap local quota tracker",
      "[Service]",
      "Type=simple",
      "ExecStart=/stable/quotacap daemon --foreground",
      "WorkingDirectory=/tmp/qc/.quotacap",
      "Environment=PATH=/opt/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      "Environment=QUOTACAP_LOG_FILE=/tmp/qc/.quotacap/logs/service.log",
      "Environment=QUOTACAP_HOME=/tmp/qc",
      "Restart=on-failure",
      "RestartSec=30",
      "[Install]",
      "WantedBy=default.target",
    ]) {
      expect(unit).toContain(needle);
    }
    expect(unit).not.toContain("After=");
    expect(isOurUnit(unit)).toBe(true);
    expect(isOurUnit("[Unit]\nDescription=other\n")).toBe(false);
  });

  it("ExecStart quotes argv elements containing spaces", () => {
    const unit = buildUnit({
      argv: ["/opt/my dir/quotacap", "daemon", "--foreground"],
      workingDirectory: "/tmp/qc",
      path: "/usr/bin:/bin",
      logFile: "/tmp/qc/service.log",
    });
    expect(unit).toContain('ExecStart="/opt/my dir/quotacap" daemon --foreground');
  });

  it("(b) fresh install writes unit+metadata; reinstall is idempotent", async () => {
    const home = mkHome();
    const dataDir = path.join(home, ".quotacap");
    const file = unitFile(home);
    const rec = recorder();
    const d = depsFor(home, rec.run, {
      which: (bin: string) => `/opt/bin/${bin}`,
    });

    await install(d);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "logs"))).toBe(true);
    expect(rec.calls).toEqual([
      ["daemon-reload"],
      ["enable", "--now", SERVICE_UNIT],
    ]);
    const meta = readServiceMetadata(dataDir)!;
    expect(meta.version).toBe(VERSION);
    expect(meta.exec).toBe("/stable/quotacap");
    expect(meta.providerPaths.claude).toBe("/opt/bin/claude");
    expect(meta.installedAt).toBeTruthy();
    const unitBefore = fs.readFileSync(file, "utf8");

    // Reinstall: no rewrite, still ensured loaded.
    rec.calls.length = 0;
    await install(d);
    expect(rec.calls).toEqual([["enable", "--now", SERVICE_UNIT]]);
    expect(fs.readFileSync(file, "utf8")).toBe(unitBefore);
    expect(
      (d as unknown as { printed: string[] }).printed.join("\n"),
    ).toMatch(/up to date/);
  });

  it("reinstall after a provider appears refreshes the unit PATH and metadata", async () => {
    const home = mkHome();
    const dataDir = path.join(home, ".quotacap");
    const file = unitFile(home);
    const rec = recorder();
    await install(
      depsFor(home, rec.run, {
        which: (bin: string) => (bin === "codex" ? null : `/opt/bin/${bin}`),
      }),
    );
    expect(readServiceMetadata(dataDir)?.providerPaths.codex).toBeNull();
    expect(fs.readFileSync(file, "utf8")).not.toContain("/new/bin");

    rec.calls.length = 0;
    await install(
      depsFor(home, rec.run, {
        which: (bin: string) =>
          bin === "codex" ? "/new/bin/codex" : `/opt/bin/${bin}`,
      }),
    );
    expect(readServiceMetadata(dataDir)?.providerPaths.codex).toBe("/new/bin/codex");
    expect(fs.readFileSync(file, "utf8")).toContain("/new/bin");
    expect(rec.calls).toEqual([
      ["stop", SERVICE_UNIT],
      ["daemon-reload"],
      ["enable", "--now", SERVICE_UNIT],
    ]);
  });

  it("(c) foreign unit at the path is refused", async () => {
    const home = mkHome();
    const file = unitFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "[Unit]\nDescription=other\n");
    const rec = recorder();
    const d = depsFor(home, rec.run);
    await expect(install(d)).rejects.toThrow(/foreign unit/);
    expect(rec.calls).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toContain("Description=other");
    await expect(uninstall(d)).rejects.toThrow(/foreign unit/);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("(d) upgrade refreshes metadata and reloads the job", async () => {
    const home = mkHome();
    const dataDir = path.join(home, ".quotacap");
    const file = unitFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      buildUnit({
        argv: ["/old/quotacap", "daemon", "--foreground"],
        workingDirectory: dataDir,
        path: "/usr/bin:/bin",
        logFile: path.join(dataDir, "logs", "service.log"),
      }),
    );
    const rec = recorder();
    const d = depsFor(home, rec.run, {
      which: (bin: string) => `/opt/bin/${bin}`,
    });
    await install(d);
    expect(rec.calls).toEqual([
      ["stop", SERVICE_UNIT],
      ["daemon-reload"],
      ["enable", "--now", SERVICE_UNIT],
    ]);
    expect(fs.readFileSync(file, "utf8")).toContain("/stable/quotacap");
    expect(readServiceMetadata(dataDir)?.version).toBe(VERSION);

    // Stopping a non-loaded job does not block the upgrade.
    const rec2 = recorder((args) =>
      args[0] === "stop" ? new Error("Unit quotacap.service not loaded") : null,
    );
    fs.writeFileSync(
      file,
      buildUnit({
        argv: ["/older/quotacap", "daemon", "--foreground"],
        workingDirectory: dataDir,
        path: "/usr/bin:/bin",
        logFile: path.join(dataDir, "logs", "service.log"),
      }),
    );
    await install(depsFor(home, rec2.run));
    expect(rec2.calls[0][0]).toBe("stop");
    expect(rec2.calls).toContainEqual(["daemon-reload"]);
    expect(rec2.calls).toContainEqual(["enable", "--now", SERVICE_UNIT]);
  });

  // The post-update path reinstalls instead of restarting (#63), so the
  // upgrade path needs the same port-release wait #61 gave restart:
  // systemctl stop returns before the port is released on this path too.
  it("upgrade waits for the port to be released before reloading", async () => {
    const home = mkHome();
    const dataDir = path.join(home, ".quotacap");
    const file = unitFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      buildUnit({
        argv: ["/old/quotacap", "daemon", "--foreground"],
        workingDirectory: dataDir,
        path: "/usr/bin:/bin",
        logFile: path.join(dataDir, "logs", "service.log"),
      }),
    );
    const order: string[] = [];
    const run = (args: string[]) => {
      order.push(args[0]);
      return "";
    };
    await install(
      depsFor(home, run, {
        waitReleased: async () => {
          order.push("wait-released");
          return true;
        },
      }),
    );
    expect(order).toEqual(["stop", "wait-released", "daemon-reload", "enable"]);
  });

  it("upgrade starts anyway, with a warning, when the port never frees", async () => {
    const home = mkHome();
    const dataDir = path.join(home, ".quotacap");
    const file = unitFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      buildUnit({
        argv: ["/old/quotacap", "daemon", "--foreground"],
        workingDirectory: dataDir,
        path: "/usr/bin:/bin",
        logFile: path.join(dataDir, "logs", "service.log"),
      }),
    );
    const rec = recorder();
    const d = depsFor(home, rec.run, { waitReleased: async () => false });
    await install(d);
    const printed = (d as unknown as { printed: string[] }).printed;
    expect(printed.some((m) => /still in use/.test(m))).toBe(true);
    expect(rec.calls.map((c) => c[0])).toEqual(["stop", "daemon-reload", "enable"]);
  });

  it("install via runServiceCommand honors an expected version on drift alone", async () => {
    const home = mkHome();
    const dataDir = path.join(home, ".quotacap");
    const rec = recorder();
    const which = (bin: string) => `/opt/bin/${bin}`;
    expect(
      await runServiceCommand(["install"], {}, depsFor(home, rec.run, { which })),
    ).toBe(0);
    expect(readServiceMetadata(dataDir)?.version).toBe(VERSION);

    // Same unit, same provider paths, but the post-update caller expects a
    // newer version: still an upgrade, and the recorded version advances.
    rec.calls.length = 0;
    expect(
      await runServiceCommand(
        ["install"],
        { version: "99.0.0" },
        depsFor(home, rec.run, { which }),
      ),
    ).toBe(0);
    expect(rec.calls).toEqual([
      ["stop", SERVICE_UNIT],
      ["daemon-reload"],
      ["enable", "--now", SERVICE_UNIT],
    ]);
    expect(readServiceMetadata(dataDir)?.version).toBe("99.0.0");
  });

  it("(e) uninstall removes only the unit", async () => {
    const home = mkHome();
    const dataDir = path.join(home, ".quotacap");
    const file = unitFile(home);
    const rec = recorder();
    const d = depsFor(home, rec.run);
    await install(d);
    expect(fs.existsSync(file)).toBe(true);
    rec.calls.length = 0;
    await uninstall(d);
    expect(rec.calls).toEqual([
      ["disable", "--now", SERVICE_UNIT],
      ["daemon-reload"],
    ]);
    expect(fs.existsSync(file)).toBe(false);
    // Quota data and config are preserved.
    expect(fs.existsSync(path.join(dataDir, "service.json"))).toBe(true);
  });

  it("(f) start/stop/restart drive systemctl with readiness", async () => {
    const home = mkHome();
    const rec = recorder();
    const waits: number[] = [];
    const d = depsFor(home, rec.run, {
      port: 18787,
      waitReady: async (p: number) => {
        waits.push(p);
        return true;
      },
    });
    await start(d);
    await stop(d);
    await restart(d);
    expect(rec.calls).toEqual([
      ["enable", "--now", SERVICE_UNIT],
      ["stop", SERVICE_UNIT],
      ["stop", SERVICE_UNIT],
      ["enable", "--now", SERVICE_UNIT],
    ]);
    expect(waits).toEqual([18787, 18787]);
  });

  it("start fails loudly when readiness never arrives", async () => {
    const home = mkHome();
    const rec = recorder();
    const d = depsFor(home, rec.run, {
      port: 18787,
      waitReady: async () => false,
    });
    await expect(start(d)).rejects.toThrow(/did not become ready on port 18787/);
  });

  it("(g) unsupported platform prints guidance and touches nothing", async () => {
    const home = mkHome();
    const file = unitFile(home);
    for (const verb of ["install", "uninstall", "start", "stop", "restart"]) {
      const rec = recorder();
      const d = depsFor(home, rec.run, { platform: "win32" });
      const fn = { install, uninstall, start, stop, restart }[verb];
      await fn!(d);
      expect(
        (d as unknown as { printed: string[] }).printed.join("\n"),
      ).toMatch(/foreground/);
      expect(rec.calls).toEqual([]);
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  it("(h) bus errors surface their cause instead of a bare dump", () => {
    const bus = formatSystemctlError(["is-active", SERVICE_UNIT], "Failed to connect to bus: No medium found");
    expect(bus.message).toContain("systemd user manager is not reachable");
    expect(bus.message).toContain("Failed to connect to bus");
    const plain = formatSystemctlError(["stop", SERVICE_UNIT], "Unit not loaded");
    expect(plain.message).toBe(
      `systemctl --user stop ${SERVICE_UNIT} failed: Unit not loaded`,
    );
  });

  it("(i) status combines unit, health, and metadata with a backend tag", async () => {
    const home = mkHome();
    const dataDir = path.join(home, ".quotacap");
    const file = unitFile(home);
    const rec = recorder(undefined, (args) => {
      if (args[0] === "is-active") return "active\n";
      if (args[0] === "show") return "MainPID=4242\nExecMainStatus=0\n";
      return "";
    });
    const d = depsFor(home, rec.run, {
      port: 1,
      which: (bin: string) => `/opt/bin/${bin}`,
    });
    await install(d);
    expect(fs.existsSync(file)).toBe(true);
    const st = await collectStatus(d);
    expect(st.backend).toBe("systemd");
    expect(st.registration.installed).toBe(true);
    expect(st.registration.loaded).toBe(true);
    expect(st.registration.pid).toBe(4242);
    expect(st.registration.plist).toBe(file);
    // Port 1 refuses: readiness records the error without hiding the rest.
    expect(st.readiness.ok).toBe(false);
    expect(st.readiness.error).toBeTruthy();
    expect(st.providers.paths?.claude).toBe("/opt/bin/claude");
  });

  it("inactive units report installed but not loaded", async () => {
    const home = mkHome();
    const file = unitFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buildUnit({
      argv: ["/stable/quotacap", "daemon", "--foreground"],
      workingDirectory: path.join(home, ".quotacap"),
      path: "/usr/bin:/bin",
      logFile: path.join(home, ".quotacap", "logs", "service.log"),
    }));
    const rec = recorder(
      (args) => (args[0] === "is-active" ? new Error("inactive") : null),
      () => "MainPID=0\nExecMainStatus=0\n",
    );
    const st = await collectStatus(depsFor(home, rec.run, { port: 1 }));
    expect(st.registration.installed).toBe(true);
    expect(st.registration.loaded).toBe(false);
    expect(st.registration.pid).toBeNull();
    expect(st.registration.error).toBeNull();
  });

  it("dispatch routes linux verbs to systemd and reports managed state", async () => {
    const home = mkHome();
    const dataDir = path.join(home, ".quotacap");
    expect(serviceSupported("linux")).toBe(true);
    expect(serviceSupported("darwin")).toBe(true);
    expect(serviceSupported("win32")).toBe(false);

    const rec = recorder(undefined, (args) => {
      if (args[0] === "is-active") return "active\n";
      if (args[0] === "show") return "MainPID=4242\nExecMainStatus=0\n";
      return "";
    });
    const d = depsFor(home, rec.run, { port: 1 }) as any;
    expect(await runServiceCommand(["install"], {}, d)).toBe(0);
    expect(fs.existsSync(unitFile(home))).toBe(true);
    expect(await isServiceManaged(d)).toBe(true);

    const down = recorder(
      (args) => (args[0] === "is-active" ? new Error("inactive") : null),
      () => "MainPID=0\n",
    );
    const d2 = depsFor(home, down.run, { port: 1 }) as any;
    expect(await isServiceManaged(d2)).toBe(false);
    expect(await isServiceManaged({ platform: "win32" })).toBe(false);
    expect(await runServiceCommand(["bogus"], {}, d)).toBe(2);
  });
});
